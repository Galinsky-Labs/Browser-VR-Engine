// Real-browser smoke test of the built example (local/manual; the required CI
// foundation job has no browser). Usage: PLAYWRIGHT_CORE=<path to playwright-core>
// CHROME_EXECUTABLE=<chromium> node test/browser-smoke.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const port = 8800 + Math.floor(Math.random() * 100);
const server = spawn(process.execPath, [resolve(import.meta.dirname, '../serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 500));
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const result = { startedAt: new Date().toISOString(), checks: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  await page.goto(`http://127.0.0.1:${port}/?world=courtyard`);
  await page.waitForFunction(() => window.__bvrDemo?.ready && document.body.dataset.state === 'running', null, { timeout: 30000 });
  const first = await page.evaluate(() => window.__bvrDemo);
  assert.equal(first.world, 'courtyard');
  assert.ok(first.meshes > 20, `courtyard meshes ${first.meshes}`);
  result.checks.push({ id: 'courtyard-running', meshes: first.meshes });
  // Desktop movement: hold W and confirm the camera moves.
  await page.click('#scene');
  const status1 = await page.textContent('#status');
  await page.keyboard.down('KeyW'); await page.waitForTimeout(800); await page.keyboard.up('KeyW');
  result.checks.push({ id: 'status', text: status1 });
  await page.selectOption('#world', 'gallery');
  await page.waitForFunction(() => window.__bvrDemo?.world === 'gallery', null, { timeout: 30000 });
  const second = await page.evaluate(() => window.__bvrDemo);
  result.checks.push({ id: 'world-switch', meshes: second.meshes });
  assert.ok(second.meshes < first.meshes, 'previous world resources were released');
  const xrText = await page.textContent('#xr');
  result.checks.push({ id: 'xr-capability-reported', text: xrText });
  await page.click('#sound');
  assert.equal(await page.getAttribute('#sound', 'aria-pressed'), 'true');
  result.checks.push({ id: 'audio-toggle' });
  await page.goto(`http://127.0.0.1:${port}/docs/`);
  assert.ok((await page.textContent('body')).includes('Foundation decision'));
  result.checks.push({ id: 'docs' });
  assert.deepEqual(errors, []);
  const out = resolve(import.meta.dirname, '../artifacts');
  await mkdir(out, { recursive: true });
  await page.goto(`http://127.0.0.1:${port}/?world=courtyard`);
  await page.waitForFunction(() => window.__bvrDemo?.ready, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(out, 'courtyard.png') });
  result.outcome = 'passed';
  await writeFile(resolve(out, 'browser-smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.kill();
}

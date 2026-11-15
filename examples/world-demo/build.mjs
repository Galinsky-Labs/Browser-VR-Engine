// Builds the static example site into dist/ (served by the Render static site).
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { marked } from './vendor-free-markdown.mjs';

const here = import.meta.dirname;
const root = resolve(here, '../..');
const out = resolve(here, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const result = await build({
  entryPoints: [resolve(here, 'src/main.js')], bundle: true, format: 'esm', target: 'es2022', minify: true,
  sourcemap: false, outfile: resolve(out, 'app.js'), metafile: true, legalComments: 'linked', logLevel: 'warning'
});
await cp(resolve(here, 'public'), out, { recursive: true });
// Apache-2.0 notices for the bundled Babylon.js code.
const babylon = resolve(root, 'node_modules/@babylonjs/core');
await writeFile(resolve(out, 'THIRD_PARTY_NOTICES.txt'), ['@babylonjs/core 9.30.0 (Apache-2.0)', await readFile(resolve(babylon, 'license.md'), 'utf8'), await readFile(resolve(babylon, 'NOTICE.md'), 'utf8')].join('\n\n'));

// Minimal docs pages rendered from the repository's Markdown records.
const docs = [['README.md', 'Overview'], ['ARCHITECTURE.md', 'Architecture'], ['HANDOFF.md', 'Handoff'], ['docs/decisions/0002-provisional-foundation-selection.md', 'Foundation decision (provisional)'], ['docs/deployment.md', 'Deployment']];
await mkdir(resolve(out, 'docs'), { recursive: true });
const links = [];
for (const [source, title] of docs) {
  const name = source.replaceAll('/', '_').replace(/\.md$/, '.html');
  const html = marked(await readFile(resolve(root, source), 'utf8'));
  await writeFile(resolve(out, 'docs', name), page(title, html));
  links.push(`<li><a href="${name}">${title}</a></li>`);
}
await writeFile(resolve(out, 'docs/index.html'), page('Browser VR Engine docs', `<h1>Browser VR Engine docs</h1><ul>${links.join('')}</ul><p><a href="../">Back to the example world</a></p>`));
const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
await writeFile(resolve(out, 'build.json'), JSON.stringify({ files: (await readdir(out)).sort(), bundleBytes: bytes }, null, 2));
console.log(`world-demo built: ${(bytes / 1024 / 1024).toFixed(2)} MiB bundle -> ${out}`);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>${title}</title><style>body{max-width:860px;margin:2rem auto;padding:0 16px;font:16px/1.6 system-ui,sans-serif;color:#1b1f27;background:#fff}pre,code{background:#f2f4f8;border-radius:4px}pre{padding:12px;overflow:auto}a{color:#2456b3}</style></head><body><p><a href="index.html">Docs</a> · <a href="../">Example world</a></p>${body}</body></html>`;
}

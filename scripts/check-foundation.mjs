// F06/F07: validate the provisional capability map against the full plan and
// the upstream pins against the lockfiles they name.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DISPOSITIONS = new Set(['reuse', 'adapt', 'implement', 'application']);
const ALLOWED_LICENSES = new Set(['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']);
const PRE_SELECTION = new Set(['F01', 'F02', 'F03', 'F04', 'F05', 'F06']);

export function validateCapabilityMap(plan, map) {
  const errors = [];
  const cards = new Map(plan.cards.map(card => [card.id, card]));
  if (map?.schemaVersion !== 1) errors.push('Capability map schemaVersion must be 1');
  if (map?.status !== 'provisional-owner-deferred') errors.push('Capability map must stay provisional until headset verification');
  if (!/headset/i.test(map?.pendingVerification ?? '')) errors.push('Capability map must name the pending headset verification');
  const seen = new Set();
  for (const entry of Array.isArray(map?.cards) ? map.cards : []) {
    if (!cards.has(entry?.card)) { errors.push(`Unknown card ${entry?.card}`); continue; }
    if (seen.has(entry.card)) errors.push(`Duplicate mapping for ${entry.card}`);
    seen.add(entry.card);
    if (!DISPOSITIONS.has(entry.disposition)) errors.push(`${entry.card} has invalid disposition ${entry.disposition}`);
    if (typeof entry.basis !== 'string' || entry.basis.trim().length < 8) errors.push(`${entry.card} needs a basis`);
    const app = cards.get(entry.card).repo === 'app';
    if (app !== (entry.disposition === 'application')) errors.push(`${entry.card} must be ${app ? 'application-owned' : 'an engine disposition'}`);
    if (/hubs|spoke|reticulum/i.test(entry.basis) && !/retired|reference/i.test(entry.basis)) errors.push(`${entry.card} maps to the retired Hubs/Spoke path`);
  }
  for (const id of cards.keys()) if (!PRE_SELECTION.has(id) && !seen.has(id)) errors.push(`Card ${id} is not assigned reuse/adapt/implement`);
  for (const id of PRE_SELECTION) if (seen.has(id)) errors.push(`Pre-selection card ${id} must not be remapped`);
  return errors;
}

export function validatePins(pins, locks) {
  const errors = [];
  if (pins?.schemaVersion !== 1 || !Array.isArray(pins?.components) || !pins.components.length) return ['Upstream pins are missing'];
  const names = new Set();
  for (const pin of pins.components) {
    if (names.has(pin?.name)) errors.push(`Duplicate pin ${pin?.name}`);
    names.add(pin?.name);
    if (!/^\d+\.\d+\.\d+$/.test(pin?.version ?? '')) errors.push(`${pin?.name} must pin an exact release`);
    if (!ALLOWED_LICENSES.has(pin?.license)) errors.push(`${pin?.name} license ${pin?.license} needs distribution review`);
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(pin?.integrity ?? '')) errors.push(`${pin?.name} needs a sha512 integrity`);
    if (typeof pin?.updateOwner !== 'string' || !pin.updateOwner.trim()) errors.push(`${pin?.name} needs an update owner`);
    if (pin?.fork !== null) errors.push(`${pin?.name} declares a fork without a patch record`);
    const lock = locks[pin?.lockfile];
    const entry = lock?.packages?.[`node_modules/${pin?.name}`];
    if (!entry) { errors.push(`${pin?.name} is not resolved by ${pin?.lockfile}`); continue; }
    if (entry.version !== pin.version || entry.integrity !== pin.integrity) errors.push(`${pin.name} lock resolution differs from the recorded pin`);
    if (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) errors.push(`${pin.name} resolves outside the public registry`);
    if (entry.license && entry.license !== pin.license) errors.push(`${pin.name} license differs from the lockfile`);
  }
  return errors;
}

/** Every direct dependency of shipped workspaces must be pinned exactly and recorded. */
export function validateWorkspaceDependencies(manifests, pins) {
  const errors = [];
  const pinned = new Map(pins.components.map(pin => [pin.name, pin.version]));
  for (const [path, manifest] of Object.entries(manifests)) {
    for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (name.startsWith('@browser-vr-engine/')) continue;
      if (!/^\d+\.\d+\.\d+$/.test(range)) errors.push(`${path}: ${name} must use an exact version`);
      else if (pinned.get(name) !== range) errors.push(`${path}: ${name}@${range} is not recorded in docs/foundation/upstream-pins.json`);
    }
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..');
  const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const plan = await json('docs/plan/pr-plan.json');
  const pins = await json('docs/foundation/upstream-pins.json');
  const locks = {};
  for (const path of new Set(pins.components.map(pin => pin.lockfile))) locks[path] = await json(path);
  const manifests = {};
  for (const path of ['package.json', 'packages/world/package.json', 'packages/runtime/package.json', 'packages/control/package.json', 'examples/world-demo/package.json']) {
    try { manifests[path] = await json(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const errors = [...validateCapabilityMap(plan, await json('docs/foundation/capability-map.json')), ...validatePins(pins, locks), ...validateWorkspaceDependencies(manifests, pins)];
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Foundation map covers every remaining card; ${pins.components.length} upstream pins match their lockfiles.`);
}

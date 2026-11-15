import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCapabilityMap, validatePins, validateWorkspaceDependencies } from '../check-foundation.mjs';

const json = async path => JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));
const plan = await json('docs/plan/pr-plan.json');
const map = await json('docs/foundation/capability-map.json');
const pins = await json('docs/foundation/upstream-pins.json');
const locks = { 'package-lock.json': await json('package-lock.json'), 'evaluations/babylon-vrspace/package-lock.json': await json('evaluations/babylon-vrspace/package-lock.json') };

test('the checked-in capability map and pins are valid', () => {
  assert.deepEqual(validateCapabilityMap(plan, map), []);
  assert.deepEqual(validatePins(pins, locks), []);
});

for (const [name, mutate, pattern] of [
  ['an unassigned card', m => { m.cards = m.cards.filter(c => c.card !== 'W07'); }, /W07 is not assigned/],
  ['a duplicate mapping', m => { m.cards.push({ ...m.cards[0] }); }, /Duplicate mapping/],
  ['an invalid disposition', m => { m.cards[0].disposition = 'maybe'; }, /invalid disposition/],
  ['an engine card owned by the application', m => { m.cards.find(c => c.card === 'W01').disposition = 'application'; }, /W01 must be an engine disposition/],
  ['an app card claimed by the engine', m => { m.cards.find(c => c.card === 'C01').disposition = 'implement'; }, /C01 must be application-owned/],
  ['a retired-path dependency', m => { m.cards.find(c => c.card === 'N02').basis = 'Use the Hubs Reticulum presence channels'; }, /retired Hubs/],
  ['acceptance before headset verification', m => { m.status = 'accepted'; }, /provisional/],
  ['remapping a pre-selection card', m => { m.cards.push({ card: 'F04', disposition: 'reuse', basis: 'something long' }); }, /Pre-selection card F04/],
  ['an unknown card', m => { m.cards.push({ card: 'Z99', disposition: 'reuse', basis: 'something long' }); }, /Unknown card Z99/]
]) test(`capability map rejects ${name}`, () => {
  const copy = structuredClone(map);
  mutate(copy);
  assert.ok(validateCapabilityMap(plan, copy).some(error => pattern.test(error)));
});

for (const [name, mutate, pattern] of [
  ['a floating version', p => { p.components[0].version = '^9.30.0'; }, /exact release/],
  ['a lock mismatch', p => { p.components[0].version = '9.29.0'; }, /lock resolution differs/],
  ['an unreviewed license', p => { p.components[0].license = 'GPL-3.0'; }, /needs distribution review/],
  ['a missing integrity', p => { p.components[0].integrity = 'sha1-abc'; }, /sha512/],
  ['an unrecorded fork', p => { p.components[0].fork = 'https://github.com/x/y'; }, /fork/],
  ['an unresolved package', p => { p.components[0].name = 'left-pad'; }, /not resolved/]
]) test(`pins reject ${name}`, () => {
  const copy = structuredClone(pins);
  mutate(copy);
  assert.ok(validatePins(copy, locks).some(error => pattern.test(error)));
});

test('workspace dependencies must be exact and recorded (example update/revert)', () => {
  assert.ok(validateWorkspaceDependencies({ x: { dependencies: { '@babylonjs/core': '^9.30.0' } } }, pins).some(e => /exact version/.test(e)));
  assert.ok(validateWorkspaceDependencies({ x: { dependencies: { '@babylonjs/core': '9.31.0' } } }, pins).some(e => /not recorded/.test(e)));
  const updated = structuredClone(pins);
  updated.components[0].version = '9.31.0';
  assert.deepEqual(validateWorkspaceDependencies({ x: { dependencies: { '@babylonjs/core': '9.31.0' } } }, updated), []);
  assert.ok(validatePins(updated, locks).some(e => /lock resolution differs/.test(e)), 'an update must also change the lockfile');
  assert.deepEqual(validatePins(pins, locks), [], 'reverting restores the recorded set');
});

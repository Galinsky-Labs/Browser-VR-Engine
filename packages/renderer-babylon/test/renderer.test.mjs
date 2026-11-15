import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NullEngine, Scene, Logger } from '@babylonjs/core';
import { expandPrefabs } from '@browser-vr-engine/world';
import { createBabylonRenderer, inspectModel } from '@browser-vr-engine/renderer-babylon';

Logger.LogLevels = Logger.ErrorLogLevel;
const fixtures = new URL('../../qualification-fixtures/fixtures/models/', import.meta.url);
const creature = new Uint8Array(await readFile(new URL('creature.gltf', fixtures)));
const prop = new Uint8Array(await readFile(new URL('prop.gltf', fixtures)));
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function world(entities, assets) {
  return { schema: 'bvr.world', version: 1, id: 'w', name: 'w', units: 'meters', axes: 'right-handed-y-up', origin: 'local', prefabs: [], assets, entities };
}
function setup() { const scene = new Scene(new NullEngine()); scene.useRightHandedSystem = true; return scene; }

test('canonical glTF assets load with skin and animation clips and dispose completely', async () => {
  const scene = setup();
  const assets = { creature: { bytes: creature, mediaType: 'model/gltf+json' }, prop: { bytes: prop, mediaType: 'model/gltf+json' } };
  const loads = [];
  const renderer = createBabylonRenderer(scene, { render: false, loadAsset: async (_, id) => { loads.push(id); return assets[id]; } });
  const w = world([
    { id: 'bird', parent: null, transform: { ...T, position: [1, 2, 3] }, components: { model: { data: { source: 'asset:creature' } } } },
    { id: 'crate', parent: null, transform: T, components: { model: { data: { source: 'asset:prop' } }, collider: { data: {} } } }
  ], [{ id: 'creature', uri: 'models/creature.gltf', mediaType: 'model/gltf+json' }, { id: 'prop', uri: 'models/prop.gltf', mediaType: 'model/gltf+json' }]);
  const handle = await renderer.mount(w, expandPrefabs(w), new AbortController().signal);
  assert.deepEqual(loads, ['creature', 'prop']);
  assert.equal(handle.containers.length, 2);
  assert.ok(scene.skeletons.length >= 1, 'skin loaded');
  assert.equal(handle.animations.length, 1, 'first creature clip autoplays; prop has none');
  assert.ok(handle.animations[0].isPlaying);
  const birdMeshes = scene.meshes.filter(m => m.metadata?.entityId === 'bird');
  assert.ok(birdMeshes.length >= 1);
  assert.ok(scene.meshes.filter(m => m.metadata?.entityId === 'crate').every(m => m.checkCollisions));
  const root = scene.getTransformNodeByName('w:bird');
  assert.ok(birdMeshes.some(m => { let p = m.parent; while (p) { if (p === root) return true; p = p.parent; } return false; }), 'model is parented under its entity');
  renderer.unmount(handle);
  assert.equal(scene.meshes.length, 0);
  assert.equal(scene.skeletons.length, 0);
  assert.equal(scene.animationGroups.length, 0);
  assert.equal(scene.transformNodes.length, 0);
});

test('model inspection rejects unsafe or unsupported inputs before loading', () => {
  assert.equal(inspectModel(creature, 'model/gltf+json').skins, 1);
  const json = o => new TextEncoder().encode(JSON.stringify(o));
  assert.throws(() => inspectModel(json({ asset: { version: '2.0' }, buffers: [{ uri: 'https://evil.example/b.bin' }] }), 'model/gltf+json'), /External glTF resource/);
  assert.throws(() => inspectModel(json({ asset: { version: '2.0' }, images: [{ uri: '../secret.png' }] }), 'model/gltf+json'), /External/);
  assert.throws(() => inspectModel(json({ asset: { version: '1.0' } }), 'model/gltf+json'), /2\.0/);
  assert.throws(() => inspectModel(json({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }), 'model/gltf+json'), /not supported/);
  assert.throws(() => inspectModel(new TextEncoder().encode('{nope'), 'model/gltf+json'), /malformed/);
  const glb = new Uint8Array(20); const v = new DataView(glb.buffer); v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, 20, true);
  assert.deepEqual(inspectModel(glb, 'model/gltf-binary'), { kind: 'glb' });
  v.setUint32(8, 999, true);
  assert.throws(() => inspectModel(glb, 'model/gltf-binary'), /length/);
  v.setUint32(0, 0, true);
  assert.throws(() => inspectModel(glb, 'model/gltf-binary'), /magic/);
  assert.throws(() => inspectModel(glb, 'model/obj'), /Unsupported model media type/);
});

test('model entities without a loader or asset fail with actionable errors and leak nothing', async () => {
  const scene = setup();
  const w = world([{ id: 'm', parent: null, transform: T, components: { model: { data: { source: 'asset:prop' } } } }], [{ id: 'prop', uri: 'p.gltf', mediaType: 'model/gltf+json' }]);
  await assert.rejects(createBabylonRenderer(scene, { render: false }).mount(w, expandPrefabs(w), new AbortController().signal), /without an asset loader/);
  const bad = createBabylonRenderer(scene, { render: false, loadAsset: async () => ({ bytes: new TextEncoder().encode('{"asset":{"version":"2.0"},"buffers":[{"uri":"x.bin"}]}'), mediaType: 'model/gltf+json' }) });
  await assert.rejects(bad.mount(w, expandPrefabs(w), new AbortController().signal), /External glTF resource/);
  assert.equal(scene.meshes.length, 0);
  assert.equal(scene.transformNodes.length, 0);
});

test('abort during an asset load releases the late container', async () => {
  const scene = setup();
  const controller = new AbortController();
  const renderer = createBabylonRenderer(scene, { render: false, loadAsset: async () => { controller.abort(); return { bytes: prop, mediaType: 'model/gltf+json' }; } });
  const w = world([{ id: 'm', parent: null, transform: T, components: { model: { data: { source: 'asset:prop' } } } }], [{ id: 'prop', uri: 'p.gltf', mediaType: 'model/gltf+json' }]);
  await assert.rejects(renderer.mount(w, expandPrefabs(w), controller.signal), /aborted/);
  assert.equal(scene.meshes.length, 0);
});

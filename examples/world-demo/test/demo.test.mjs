import test from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine, Scene, Vector3, Quaternion, Logger } from '@babylonjs/core';
import { validateWorld, expandPrefabs, serializeWorld, parseWorld } from '@browser-vr-engine/world';
import { createRuntime, createLocalServices } from '@browser-vr-engine/runtime';
import { createBabylonRenderer, createEngineScheduler } from '@browser-vr-engine/renderer-babylon';
import { WORLDS, courtyard, gallery } from '../src/worlds.js';
import { marked } from '../vendor-free-markdown.mjs';

Logger.LogLevels = Logger.ErrorLogLevel;

function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  return { engine, scene };
}
const counts = scene => ({ meshes: scene.meshes.length, materials: scene.materials.length, lights: scene.lights.length, nodes: scene.transformNodes.length });

test('example worlds are valid engine documents and round-trip', () => {
  for (const factory of Object.values(WORLDS)) {
    const world = factory();
    assert.deepEqual(validateWorld(world), [], world.id);
    assert.equal(serializeWorld(parseWorld(serializeWorld(world))), serializeWorld(world));
  }
});

test('the Babylon adapter builds the courtyard scene with solid colliders, lights and emitters', async () => {
  const { scene } = setup();
  const renderer = createBabylonRenderer(scene, { render: false });
  const world = courtyard();
  const entities = expandPrefabs(world);
  const handle = await renderer.mount(world, entities, new AbortController().signal);
  const meshEntities = entities.filter(e => e.components.mesh).length;
  assert.equal(handle.meshes.length, meshEntities);
  assert.equal(scene.meshes.length, meshEntities);
  assert.equal(scene.transformNodes.length, entities.length);
  assert.equal(handle.lights.length, entities.filter(e => e.components.light).length);
  assert.ok(scene.meshes.filter(m => m.checkCollisions).length >= 12);
  assert.equal(handle.floors.length, 2);
  assert.equal(handle.sounds.length, 2);
  assert.equal(handle.spawn.entityId, 'spawn');
  // Prefab instances are parented under their instance node with composite ids.
  const bulb = scene.getTransformNodeByName('courtyard:lamp-3/bulb');
  assert.equal(bulb.parent.name, 'courtyard:lamp-3/post');
  scene.computeActiveMeshes?.();
  const world3 = bulb.getAbsolutePosition();
  assert.ok(Math.abs(world3.x - 5) < 1e-6 && Math.abs(world3.y - 2.5) < 1e-6 && Math.abs(world3.z - 5) < 1e-6, world3.toString());
  // Negative scale is preserved on the mirrored screen.
  assert.equal(scene.getTransformNodeByName('courtyard:screen').scaling.x, -1);
  renderer.unmount(handle);
});

test('behaviours advance deterministically with frame time', async () => {
  const { scene } = setup();
  const renderer = createBabylonRenderer(scene, { render: false });
  const world = courtyard();
  const handle = await renderer.mount(world, expandPrefabs(world), new AbortController().signal);
  const bird = scene.getTransformNodeByName('courtyard:bird');
  const start = bird.position.clone();
  for (let i = 0; i < 60; i++) renderer.renderFrame(handle, 1 / 60);
  const angle = 0.5; // speed 0.5 rad/s for one second
  assert.ok(Math.abs(bird.position.x - 6 * Math.cos(angle)) < 1e-9);
  assert.ok(Math.abs(bird.position.z - 6 * Math.sin(angle)) < 1e-9);
  assert.notDeepEqual(bird.position.asArray(), start.asArray());
  const sculpture = scene.getTransformNodeByName('courtyard:sculpture');
  const expected = Quaternion.RotationAxis(Vector3.Up(), 0.8);
  assert.ok(sculpture.rotationQuaternion.equalsWithEpsilon(expected, 1e-9));
  renderer.unmount(handle);
});

test('unmount releases every resource; ten load cycles through the runtime retain nothing', async () => {
  const { engine, scene } = setup();
  const baseline = counts(scene);
  const renderer = createBabylonRenderer(scene);
  const runtime = createRuntime({ renderer, services: createLocalServices({ capabilities: ['world:load:local'] }), scheduler: createEngineScheduler(engine, () => 0) });
  for (let cycle = 0; cycle < 10; cycle++) {
    await runtime.load(cycle % 2 ? gallery() : courtyard());
    runtime.start();
    assert.equal(runtime.activeFrameLoops, 1);
    const expected = cycle % 2 ? gallery() : courtyard();
    assert.equal(scene.meshes.length, expandPrefabs(expected).filter(e => e.components.mesh).length);
  }
  runtime.dispose();
  assert.deepEqual(counts(scene), baseline);
  engine.dispose();
});

test('aborted mounts release partially created resources', async () => {
  const { scene } = setup();
  const renderer = createBabylonRenderer(scene, { render: false });
  const controller = new AbortController();
  const world = courtyard();
  const entities = expandPrefabs(world);
  const many = Array.from({ length: 200 }, (_, i) => ({ ...entities[2], id: `g${i}` }));
  const pending = renderer.mount(world, many, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(scene.meshes.length, 0);
  assert.equal(scene.transformNodes.length, 0);
});

test('unsupported primitives fail with an actionable error and no leaked resources', async () => {
  const { scene } = setup();
  const renderer = createBabylonRenderer(scene, { render: false });
  const world = gallery();
  const entities = expandPrefabs(world);
  entities.push({ id: 'bad', parent: null, transform: entities[0].transform, components: { mesh: { data: { primitive: 'teapot' } } } });
  await assert.rejects(renderer.mount(world, entities, new AbortController().signal), /Unsupported mesh primitive "teapot"/);
  assert.equal(scene.meshes.length, 0);
});

test('docs Markdown renderer escapes HTML and drops script links', () => {
  const html = marked('# T <x>\n\nSee [a](javascript:alert(1)) and [b](https://example.com) `<b>`\n\n- one\n- two\n\n```\n<script>\n```');
  assert.ok(html.includes('<h1>T &lt;x&gt;</h1>'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('<a href="https://example.com">b</a>'));
  assert.ok(html.includes('<code>&lt;b&gt;</code>'));
  assert.ok(html.includes('<pre><code>&lt;script&gt;</code></pre>'));
  assert.ok(html.includes('<ul>') && html.includes('</ul>'));
});

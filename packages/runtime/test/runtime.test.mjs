import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, createLocalServices, bindVisibility, ActionState, LoadCancelledError } from '@browser-vr-engine/runtime';

const world = (id, extra = {}) => ({
  schema: 'bvr.world', version: 1, id, name: id, units: 'meters', axes: 'right-handed-y-up', origin: 'local', assets: [], prefabs: [],
  entities: [{ id: 'floor', parent: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: { mesh: { data: { primitive: 'ground' } } } }],
  ...extra
});

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

/** Fake renderer that tracks live resources so tests can inspect retained counts. */
function fakeRenderer({ manual = false } = {}) {
  const live = new Set();
  const gates = [];
  let next = 0;
  return {
    live, gates, frames: [],
    async mount(w, entities, signal) {
      if (manual) { const gate = deferred(); gates.push({ id: w.id, gate, signal }); await gate.promise; }
      const handle = { id: ++next, world: w.id, entities: entities.length };
      live.add(handle);
      return handle;
    },
    unmount(handle) { live.delete(handle); },
    renderFrame(handle, dt) { this.frames.push([handle.world, dt]); }
  };
}

function manualScheduler() {
  const queue = new Map();
  let id = 0;
  return {
    queue,
    request(cb) { queue.set(++id, cb); return id; },
    cancel(handle) { queue.delete(handle); },
    flush(time) { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(cb => cb(time)); }
  };
}

const local = () => createLocalServices({ capabilities: ['world:load:local', 'persistence:local', 'transport:local'] });

test('a minimal world starts without accounts, application API or media server', async () => {
  const renderer = fakeRenderer();
  const scheduler = manualScheduler();
  const runtime = createRuntime({ renderer, services: local(), scheduler });
  const events = [];
  runtime.on(event => events.push(event.type === 'state' ? `${event.from}>${event.to}` : event.type));
  await runtime.load(world('a'));
  runtime.start();
  scheduler.flush(1000); scheduler.flush(1016);
  assert.equal(runtime.state, 'running');
  assert.equal(runtime.frames, 2);
  assert.equal(renderer.frames[1][1], 0.016);
  assert.equal(runtime.activeFrameLoops, 1);
  assert.deepEqual(events, ['created>loading', 'loading>loaded', 'loaded', 'loaded>running']);
});

test('loading another world cancels obsolete work and disposes the previous world', async () => {
  const renderer = fakeRenderer({ manual: true });
  const runtime = createRuntime({ renderer, services: local(), scheduler: manualScheduler() });
  const first = runtime.load(world('first'));
  await new Promise(setImmediate);
  const second = runtime.load(world('second'));
  await new Promise(setImmediate);
  assert.equal(renderer.gates[0].signal.aborted, true);
  renderer.gates[1].gate.resolve();
  assert.equal((await second).id, 'second');
  // The obsolete load resolves late; its resources must be released, never published.
  renderer.gates[0].gate.resolve();
  await assert.rejects(first, LoadCancelledError);
  assert.equal(runtime.world.id, 'second');
  assert.equal(renderer.live.size, 1);
  const third = runtime.load(world('third'));
  await new Promise(setImmediate);
  renderer.gates[2].gate.resolve();
  await third;
  assert.deepEqual([...renderer.live].map(h => h.world), ['third']);
});

test('failed loads keep the previous world and report the failure', async () => {
  const renderer = fakeRenderer();
  const runtime = createRuntime({ renderer, services: local(), scheduler: manualScheduler() });
  await runtime.load(world('good'));
  runtime.start();
  const failures = [];
  runtime.on(event => { if (event.type === 'load-failed') failures.push(event.error.message); });
  await assert.rejects(runtime.load(world('bad', { units: 'feet' })), /units/);
  await assert.rejects(runtime.load('{not json'), SyntaxError);
  assert.equal(runtime.world.id, 'good');
  assert.equal(runtime.state, 'running');
  assert.equal(runtime.activeFrameLoops, 1);
  assert.equal(failures.length, 2);
});

test('repeated mount/unmount and suspended-tab recovery keep one frame loop', async () => {
  const renderer = fakeRenderer();
  const scheduler = manualScheduler();
  const runtime = createRuntime({ renderer, services: local(), scheduler });
  for (let cycle = 0; cycle < 10; cycle++) {
    await runtime.load(world(`w${cycle}`));
    runtime.start(); runtime.start();
    runtime.suspend(); runtime.resume(); runtime.resume();
    assert.equal(scheduler.queue.size, 1);
    assert.equal(runtime.activeFrameLoops, 1);
    runtime.unload();
    assert.equal(scheduler.queue.size, 0);
    assert.equal(renderer.live.size, 0);
  }
  const doc = { hidden: false, listeners: new Set(), addEventListener(_, cb) { this.listeners.add(cb); }, removeEventListener(_, cb) { this.listeners.delete(cb); } };
  await runtime.load(world('tab'));
  runtime.start();
  const unbind = bindVisibility(runtime, doc);
  doc.hidden = true; doc.listeners.forEach(cb => cb());
  assert.equal(runtime.state, 'suspended');
  assert.equal(scheduler.queue.size, 0);
  doc.hidden = false; doc.listeners.forEach(cb => cb());
  assert.equal(runtime.state, 'running');
  assert.equal(scheduler.queue.size, 1);
  unbind();
  assert.equal(doc.listeners.size, 0);
  runtime.dispose();
  assert.equal(scheduler.queue.size, 0);
  assert.equal(renderer.live.size, 0);
  assert.throws(() => runtime.start(), /disposed/);
  await assert.rejects(runtime.load(world('x')), /disposed/);
});

test('dispose during a pending load releases the late result', async () => {
  const renderer = fakeRenderer({ manual: true });
  const runtime = createRuntime({ renderer, services: local(), scheduler: manualScheduler() });
  const loading = runtime.load(world('late'));
  await new Promise(setImmediate);
  runtime.dispose();
  renderer.gates[0].gate.resolve();
  await assert.rejects(loading, LoadCancelledError);
  assert.equal(renderer.live.size, 0);
  assert.equal(runtime.state, 'disposed');
});

test('local mode never silently authorizes a remote world', async () => {
  const runtime = createRuntime({ renderer: fakeRenderer(), services: local(), scheduler: manualScheduler() });
  await assert.rejects(runtime.load(world('far', { origin: 'remote' })), /Not authorized to load remote world "far"/);
  const trusted = createLocalServices({ capabilities: ['world:load:local', 'world:load:remote'], trustedRemoteWorlds: ['far'] });
  const second = createRuntime({ renderer: fakeRenderer(), services: trusted, scheduler: manualScheduler() });
  assert.equal((await second.load(world('far', { origin: 'remote' }))).id, 'far');
  await assert.rejects(second.load(world('other', { origin: 'remote' })), /Not authorized/);
  const none = createRuntime({ renderer: fakeRenderer(), services: createLocalServices({ capabilities: [] }), scheduler: manualScheduler() });
  await assert.rejects(none.load(world('a')), /Not authorized to load local world/);
});

test('local services enforce their explicit capabilities', async () => {
  const services = local();
  await services.persistence.save('k', 'v');
  assert.equal(await services.persistence.load('k'), 'v');
  const received = [];
  const off = services.transport.subscribe('chat', message => received.push(message));
  const message = { text: 'hi' };
  services.transport.send('chat', message);
  off();
  services.transport.send('chat', { text: 'ignored' });
  assert.deepEqual(received, [{ text: 'hi' }]);
  assert.notEqual(received[0], message);
  const bare = createLocalServices({ capabilities: ['world:load:local'] });
  await assert.rejects(bare.persistence.load('k'), /not granted/);
  assert.throws(() => bare.transport.send('c', 1), /not granted/);
  assert.equal(bare.transport.kind, 'none');
  const w = world('assets', { assets: [{ id: 'tex', uri: 'textures/a.png', mediaType: 'image/png' }] });
  assert.equal(createLocalServices({ capabilities: [], assetBase: '/bundle/' }).assets.resolve(w, 'tex'), '/bundle/textures/a.png');
  assert.throws(() => services.assets.resolve(w, 'nope'), /Unknown asset/);
});

test('action input maps desktop keys and normalizes diagonal movement', () => {
  const input = new ActionState();
  assert.equal(input.keyDown('KeyW'), 'forward');
  input.keyDown('KeyD');
  const { x, z } = input.movement();
  assert.ok(Math.abs(Math.hypot(x, z) - 1) < 1e-12 && x > 0 && z > 0);
  input.keyUp('KeyW');
  assert.deepEqual(input.movement(), { x: 1, z: 0 });
  assert.equal(input.keyDown('KeyQ'), null);
  input.press('interact');
  assert.ok(input.has('interact'));
  input.clear();
  assert.deepEqual(input.movement(), { x: 0, z: 0 });
});

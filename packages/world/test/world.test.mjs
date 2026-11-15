import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWorld, assertWorld, expandPrefabs, serializeWorld, parseWorld, migrateWorld, canonicalize, eulerDegreesToQuat, WorldValidationError } from '@browser-vr-engine/world';

const t = (position = [0, 0, 0], scale = [1, 1, 1]) => ({ position, rotation: [0, 0, 0, 1], scale });

function fixture() {
  return {
    schema: 'bvr.world', version: 1, id: 'courtyard', name: 'Courtyard', units: 'meters', axes: 'right-handed-y-up', origin: 'local',
    assets: [{ id: 'talk-video', uri: 'media/talk.mp4', mediaType: 'video/mp4' }, { id: 'fountain', uri: 'audio/fountain.ogg', mediaType: 'audio/ogg' }],
    prefabs: [
      { id: 'lamp', entities: [
        { id: 'post', parent: null, transform: t(), components: { mesh: { data: { primitive: 'cylinder', height: 2 } } } },
        { id: 'bulb', parent: 'post', transform: t([0, 2, 0]), components: { light: { data: { kind: 'point', intensity: 0.4 } } } }
      ] },
      { id: 'lamp-pair', entities: [
        { id: 'left', parent: null, transform: t([-1, 0, 0]), components: {}, prefab: { ref: 'lamp' } },
        { id: 'right', parent: null, transform: t([1, 0, 0], [-1, 1, 1]), components: {}, prefab: { ref: 'lamp', overrides: { bulb: { light: { data: { kind: 'point', intensity: 0.9 } } } } } }
      ] }
    ],
    entities: [
      { id: 'root', parent: null, transform: t(), components: {} },
      { id: 'screen', parent: 'root', transform: t([0, 2, -5], [-2, 1, 1]), components: { 'media-surface': { required: true, data: { source: 'asset:talk-video', aspect: 1.777 } } } },
      { id: 'fountain', parent: 'root', transform: t([3, 0, 3]), components: { audio: { data: { source: 'asset:fountain', loop: true, refDistance: 2 } }, behavior: { data: { kind: 'spin', speed: 0.5 } } } },
      { id: 'gate-lamps', parent: 'root', transform: t([0, 0, 6]), components: {}, prefab: { ref: 'lamp-pair' } },
      { id: 'mystery', parent: 'root', transform: t(), components: { 'vendor/sparkle': { data: { opaque: [1, 2, { nested: true }] } } } }
    ]
  };
}

test('fixture with nested prefabs, negative scales, media and behavior validates', () => {
  assert.deepEqual(validateWorld(fixture()), []);
});

test('nested prefab expansion yields stable composite ids, parents and overrides', () => {
  const entities = expandPrefabs(fixture());
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  assert.equal(entities.length, 5 + 2 + 4);
  assert.equal(byId.get('gate-lamps/left').parent, 'gate-lamps');
  assert.equal(byId.get('gate-lamps/right/post').parent, 'gate-lamps/right');
  assert.equal(byId.get('gate-lamps/right/bulb').parent, 'gate-lamps/right/post');
  assert.equal(byId.get('gate-lamps/right/bulb').components.light.data.intensity, 0.9);
  assert.equal(byId.get('gate-lamps/left/bulb').components.light.data.intensity, 0.4);
  assert.deepEqual(byId.get('gate-lamps/right').transform.scale, [-1, 1, 1]);
  assert.equal(expandPrefabs(fixture()).map(e => e.id).join(), entities.map(e => e.id).join());
});

test('round trip preserves identity, negative scale and unknown optional components', () => {
  const text = serializeWorld(fixture());
  const parsed = parseWorld(text);
  assert.equal(serializeWorld(parsed), text);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(fixture())));
  assert.deepEqual(parsed.entities.find(e => e.id === 'mystery').components['vendor/sparkle'], { data: { opaque: [1, 2, { nested: true }] } });
});

test('canonical form is independent of key order', () => {
  assert.equal(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalize({ a: [{ c: 3, d: 2 }], b: 1 }));
});

const cases = [
  ['duplicate identifiers', w => { w.entities.push({ ...w.entities[0] }); }, /duplicate entity id "root"/],
  ['parent cycles', w => { w.entities[0].parent = 'screen'; }, /parent cycle/],
  ['unresolved parent', w => { w.entities[1].parent = 'ghost'; }, /unresolved parent "ghost"/],
  ['malformed asset reference', w => { w.entities[1].components['media-surface'].data.source = 'asset:missing'; }, /unresolved asset reference "missing"/],
  ['unknown required component', w => { w.entities[4].components['vendor/sparkle'].required = true; }, /required component type "vendor\/sparkle" is not supported/],
  ['prototype pollution keys', w => { w.entities[1].components.label = JSON.parse('{"data":{"__proto__":{"x":1}}}'); }, /forbidden key "__proto__"/],
  ['constructor key', w => { w.entities[1].components.label = { data: { constructor: 1 } }; }, /forbidden key "constructor"/],
  ['external asset URLs', w => { w.assets[0].uri = 'https://evil.example/x.mp4'; }, /external reference/],
  ['path traversal', w => { w.assets[0].uri = '../secret.mp4'; }, /relative path inside the bundle/],
  ['non-finite coordinates', w => { w.entities[0].transform.position = [0, Infinity, 0]; }, /position must be three finite/],
  ['out-of-range coordinates', w => { w.entities[0].transform.position = [0, 2e6, 0]; }, /position must be three finite/],
  ['unnormalized quaternion', w => { w.entities[0].transform.rotation = [0, 0, 0, 2]; }, /rotation/],
  ['zero scale', w => { w.entities[0].transform.scale = [0, 1, 1]; }, /must not contain zero/],
  ['oversized component', w => { w.entities[0].components.label = { data: 'x'.repeat(70_000) }; }, /exceeds 65536/],
  ['wrong axes', w => { w.axes = 'left-handed-y-up'; }, /right-handed-y-up/],
  ['wrong units', w => { w.units = 'feet'; }, /meters/],
  ['unknown prefab', w => { w.entities[3].prefab.ref = 'ghost'; }, /unresolved prefab "ghost"/],
  ['prefab cycle', w => { w.prefabs[0].entities[0].prefab = { ref: 'lamp-pair' }; }, /prefab cycle/],
  ['override of unknown prefab entity', w => { w.prefabs[1].entities[1].prefab.overrides = { nope: {} }; }, /override targets unknown prefab entity "nope"/],
  ['future version', w => { w.version = 2; }, /not supported; run migrateWorld/]
];
for (const [name, mutate, pattern] of cases) {
  test(`rejects ${name}`, () => {
    const world = fixture();
    mutate(world);
    const issues = validateWorld(world);
    assert.ok(issues.some(issue => pattern.test(issue)), issues.join('\n'));
    assert.throws(() => assertWorld(world), WorldValidationError);
  });
}

test('expanded entity count is bounded', () => {
  const world = fixture();
  assert.ok(validateWorld(world, { limits: { maxEntities: 6 } }).some(issue => /exceed/.test(issue)));
});

test('hosts can register additional required component types', () => {
  const world = fixture();
  world.entities[4].components['vendor/sparkle'].required = true;
  assert.deepEqual(validateWorld(world, { components: ['vendor/sparkle'] }), []);
});

test('version 0 documents migrate without losing ids and with Y-up quaternions', () => {
  const legacy = { schema: 'bvr.world', version: 0, id: 'old', name: 'Old', units: 'meters', axes: 'right-handed-y-up',
    objects: [{ id: 'a', position: [1, 2, 3], rotationDegrees: [0, 90, 0], components: { label: { data: 'hi' } } }, { id: 'b', parent: 'a', scale: [-1, 1, 1] }] };
  const migrated = migrateWorld(legacy);
  assert.deepEqual(validateWorld(migrated), []);
  assert.deepEqual(migrated.entities.map(e => e.id), ['a', 'b']);
  const [x, y, z, w] = migrated.entities[0].transform.rotation;
  assert.ok(Math.abs(x) < 1e-12 && Math.abs(z) < 1e-12);
  assert.ok(Math.abs(y - Math.SQRT1_2) < 1e-12 && Math.abs(w - Math.SQRT1_2) < 1e-12);
  assert.deepEqual(parseWorld(JSON.stringify(legacy)).entities[1].transform.scale, [-1, 1, 1]);
});

test('Euler conversion yields unit quaternions', () => {
  for (const [a, b, c] of [[10, 20, 30], [-90, 45, 180], [0, 0, 0]]) {
    assert.ok(Math.abs(Math.hypot(...eulerDegreesToQuat(a, b, c)) - 1) < 1e-12);
  }
});

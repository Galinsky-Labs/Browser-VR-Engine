// Original example worlds in the engine world format (W01). No third-party assets.
const T = (position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0, 1]) => ({ position, rotation, scale });
const yaw = degrees => [0, Math.sin((degrees * Math.PI) / 360), 0, Math.cos((degrees * Math.PI) / 360)];
const box = (width, height, depth) => ({ data: { primitive: 'box', width, height, depth } });
const paint = (color, emissive) => ({ data: emissive ? { color, emissive } : { color } });
const solid = { data: { shape: 'mesh' } };

function base(id, name) {
  return { schema: 'bvr.world', version: 1, id, name, units: 'meters', axes: 'right-handed-y-up', origin: 'local', assets: [], prefabs: [], entities: [] };
}

export function courtyard() {
  const world = base('courtyard', 'Courtyard');
  world.prefabs.push({
    id: 'lamp',
    entities: [
      { id: 'post', parent: null, transform: T([0, 1.2, 0]), components: { mesh: { data: { primitive: 'cylinder', height: 2.4, diameter: 0.12 } }, material: paint([0.15, 0.15, 0.18]), collider: solid } },
      { id: 'bulb', parent: 'post', transform: T([0, 1.3, 0]), components: { mesh: { data: { primitive: 'sphere', diameter: 0.35 } }, material: paint([1, 0.9, 0.6], [1, 0.85, 0.5]), light: { data: { kind: 'point', intensity: 0.35, color: [1, 0.85, 0.6] } } } }
    ]
  });
  const e = world.entities;
  e.push({ id: 'sky', parent: null, transform: T(), components: { light: { data: { kind: 'hemispheric', intensity: 0.85 } } } });
  e.push({ id: 'sun', parent: null, transform: T(), components: { light: { data: { kind: 'directional', intensity: 0.45, direction: [-0.4, -1, 0.3] } } } });
  e.push({ id: 'ground', parent: null, transform: T(), components: { mesh: { data: { primitive: 'ground', width: 30, depth: 30 } }, material: paint([0.42, 0.55, 0.36]), collider: { data: { shape: 'mesh', floor: true } } } });
  e.push({ id: 'plaza', parent: null, transform: T([0, 0.01, 0]), components: { mesh: { data: { primitive: 'ground', width: 12, depth: 12 } }, material: paint([0.72, 0.68, 0.6]), collider: { data: { shape: 'mesh', floor: true } } } });
  // Perimeter walls with an open arch to the north.
  e.push({ id: 'wall-south', parent: null, transform: T([0, 1.5, 15]), components: { mesh: box(30, 3, 0.4), material: paint([0.78, 0.72, 0.64]), collider: solid } });
  e.push({ id: 'wall-east', parent: null, transform: T([15, 1.5, 0]), components: { mesh: box(0.4, 3, 30), material: paint([0.78, 0.72, 0.64]), collider: solid } });
  e.push({ id: 'wall-west', parent: null, transform: T([-15, 1.5, 0]), components: { mesh: box(0.4, 3, 30), material: paint([0.78, 0.72, 0.64]), collider: solid } });
  e.push({ id: 'wall-north-left', parent: null, transform: T([-8.5, 1.5, -15]), components: { mesh: box(13, 3, 0.4), material: paint([0.78, 0.72, 0.64]), collider: solid } });
  e.push({ id: 'wall-north-right', parent: null, transform: T([8.5, 1.5, -15]), components: { mesh: box(13, 3, 0.4), material: paint([0.78, 0.72, 0.64]), collider: solid } });
  e.push({ id: 'arch', parent: null, transform: T([0, 3.2, -15]), components: { mesh: box(4.4, 0.6, 0.6), material: paint([0.6, 0.5, 0.42]), collider: solid } });
  // Fountain with an attached sound emitter.
  e.push({ id: 'fountain', parent: null, transform: T([0, 0.35, 0]), components: { mesh: { data: { primitive: 'cylinder', height: 0.7, diameter: 3 } }, material: paint([0.55, 0.57, 0.62]), collider: solid, audio: { data: { kind: 'tone', frequency: 196, gain: 0.25, refDistance: 1.5 } } } });
  e.push({ id: 'water', parent: 'fountain', transform: T([0, 0.36, 0]), components: { mesh: { data: { primitive: 'cylinder', height: 0.02, diameter: 2.6 } }, material: paint([0.25, 0.5, 0.85], [0.05, 0.12, 0.25]) } });
  e.push({ id: 'jet', parent: 'fountain', transform: T([0, 1.1, 0]), components: { mesh: { data: { primitive: 'cone', height: 1.4, diameter: 0.5 } }, material: paint([0.6, 0.8, 1], [0.2, 0.3, 0.45]), behavior: { data: { kind: 'bob', amplitude: 0.15, speed: 2.2 } } } });
  // A "bird" that circles the plaza, carrying its own sound.
  e.push({ id: 'bird', parent: null, transform: T([0, 4, 0]), components: { mesh: { data: { primitive: 'sphere', diameter: 0.4 } }, material: paint([0.9, 0.3, 0.2], [0.3, 0.05, 0.02]), behavior: { data: { kind: 'orbit', radius: 6, speed: 0.5 } }, audio: { data: { kind: 'tone', frequency: 880, gain: 0.08, refDistance: 1 } } } });
  e.push({ id: 'bird-wing', parent: 'bird', transform: T([0, 0, 0], [1, 0.1, 0.3]), components: { mesh: { data: { primitive: 'box', size: 1 } }, material: paint([0.95, 0.5, 0.35]) } });
  // Props and decorations.
  const crates = [[-4, 0.5, 4, 0], [-3, 0.5, 5.2, 25], [-3.6, 1.5, 4.6, 10], [5, 0.5, -4, 45]];
  crates.forEach(([x, y, z, r], index) => e.push({ id: `crate-${index}`, parent: null, transform: T([x, y, z], [1, 1, 1], yaw(r)), components: { mesh: box(1, 1, 1), material: paint([0.6, 0.42, 0.24]), collider: solid } }));
  e.push({ id: 'sculpture', parent: null, transform: T([6, 1.6, 6]), components: { mesh: { data: { primitive: 'torus', diameter: 1.6, thickness: 0.3 } }, material: paint([0.85, 0.7, 0.2], [0.2, 0.15, 0]), behavior: { data: { kind: 'spin', speed: 0.8 } } } });
  e.push({ id: 'screen', parent: null, transform: T([0, 2.2, 14.7], [-1, 1, 1]), components: { mesh: { data: { primitive: 'plane', width: 5.333, height: 3 } }, material: paint([0.1, 0.12, 0.2], [0.15, 0.2, 0.35]), label: { data: 'Media surface placeholder (M09)' } } });
  [[-5, -5], [5, -5], [-5, 5], [5, 5]].forEach(([x, z], index) => e.push({ id: `lamp-${index}`, parent: null, transform: T([x, 0, z]), components: {}, prefab: { ref: 'lamp' } }));
  e.push({ id: 'spawn', parent: null, transform: T([0, 1.7, 9]), components: { spawn: { data: { facing: 'north' } } } });
  return world;
}

export function gallery() {
  const world = base('gallery', 'Gallery');
  const e = world.entities;
  e.push({ id: 'sky', parent: null, transform: T(), components: { light: { data: { kind: 'hemispheric', intensity: 0.7, color: [0.9, 0.92, 1] } } } });
  e.push({ id: 'floor', parent: null, transform: T(), components: { mesh: { data: { primitive: 'ground', width: 16, depth: 24 } }, material: paint([0.2, 0.2, 0.24]), collider: { data: { shape: 'mesh', floor: true } } } });
  e.push({ id: 'wall-left', parent: null, transform: T([-8, 2, 0]), components: { mesh: box(0.3, 4, 24), material: paint([0.92, 0.92, 0.9]), collider: solid } });
  e.push({ id: 'wall-right', parent: null, transform: T([8, 2, 0]), components: { mesh: box(0.3, 4, 24), material: paint([0.92, 0.92, 0.9]), collider: solid } });
  e.push({ id: 'wall-back', parent: null, transform: T([0, 2, -12]), components: { mesh: box(16, 4, 0.3), material: paint([0.92, 0.92, 0.9]), collider: solid } });
  e.push({ id: 'wall-front', parent: null, transform: T([0, 2, 12]), components: { mesh: box(16, 4, 0.3), material: paint([0.92, 0.92, 0.9]), collider: solid } });
  const palette = [[0.85, 0.25, 0.3], [0.25, 0.6, 0.85], [0.95, 0.75, 0.2], [0.35, 0.8, 0.45], [0.65, 0.4, 0.85], [0.95, 0.5, 0.25]];
  palette.forEach((color, index) => {
    const side = index % 2 === 0 ? -1 : 1;
    const z = -8 + Math.floor(index / 2) * 7;
    e.push({ id: `plinth-${index}`, parent: null, transform: T([side * 4.5, 0.5, z]), components: { mesh: box(1, 1, 1), material: paint([0.95, 0.95, 0.95]), collider: solid } });
    e.push({ id: `exhibit-${index}`, parent: `plinth-${index}`, transform: T([0, 1.1, 0]), components: { mesh: { data: { primitive: ['sphere', 'torus', 'cone'][index % 3], diameter: 0.7, height: 0.9, thickness: 0.15 } }, material: paint(color, color.map(c => c * 0.25)), behavior: { data: { kind: 'spin', speed: 0.6 + index * 0.1 } } } });
    e.push({ id: `spot-${index}`, parent: `plinth-${index}`, transform: T([0, 2.5, 0]), components: { light: { data: { kind: 'point', intensity: 0.25, color } } } });
  });
  e.push({ id: 'chime', parent: 'exhibit-2', transform: T(), components: { audio: { data: { kind: 'tone', frequency: 523.25, gain: 0.12, refDistance: 1 } } } });
  e.push({ id: 'spawn', parent: null, transform: T([0, 1.7, 10]), components: { spawn: { data: { facing: 'north' } } } });
  return world;
}

export const WORLDS = Object.freeze({ courtyard, gallery });

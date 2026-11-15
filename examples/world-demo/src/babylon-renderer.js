// Babylon.js RendererPort adapter for the provisionally selected foundation (F06).
// Maps validated engine world entities to Babylon scene resources and releases
// every resource it created on unmount. Promoted to a package by W03.
import { TransformNode, MeshBuilder, StandardMaterial, Color3, Vector3, Quaternion, HemisphericLight, PointLight, DirectionalLight } from '@babylonjs/core';

const vec = value => new Vector3(value[0], value[1], value[2]);
const color = (value, fallback = [0.8, 0.8, 0.8]) => Color3.FromArray(Array.isArray(value) && value.length === 3 ? value : fallback);
const num = (value, fallback, min = 0.001, max = 10_000) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback);

function createMesh(name, data, scene) {
  switch (data?.primitive) {
    case 'box': return MeshBuilder.CreateBox(name, { width: num(data.width ?? data.size, 1), height: num(data.height ?? data.size, 1), depth: num(data.depth ?? data.size, 1) }, scene);
    case 'sphere': return MeshBuilder.CreateSphere(name, { diameter: num(data.diameter, 1), segments: 16 }, scene);
    case 'cylinder': return MeshBuilder.CreateCylinder(name, { height: num(data.height, 1), diameter: num(data.diameter, 1), tessellation: 24 }, scene);
    case 'cone': return MeshBuilder.CreateCylinder(name, { height: num(data.height, 1), diameterTop: 0, diameterBottom: num(data.diameter, 1), tessellation: 24 }, scene);
    case 'torus': return MeshBuilder.CreateTorus(name, { diameter: num(data.diameter, 1), thickness: num(data.thickness, 0.2), tessellation: 32 }, scene);
    case 'ground': return MeshBuilder.CreateGround(name, { width: num(data.width, 10), height: num(data.depth, 10) }, scene);
    case 'plane': return MeshBuilder.CreatePlane(name, { width: num(data.width, 1), height: num(data.height, 1), sideOrientation: 2 }, scene);
    default: throw new Error(`Unsupported mesh primitive "${String(data?.primitive)}" on ${name}`);
  }
}

function createLight(name, data, scene) {
  let light;
  if (data?.kind === 'point') light = new PointLight(name, Vector3.Zero(), scene);
  else if (data?.kind === 'directional') light = new DirectionalLight(name, vec(Array.isArray(data.direction) ? data.direction : [0, -1, 0]), scene);
  else light = new HemisphericLight(name, new Vector3(0, 1, 0), scene);
  light.intensity = num(data?.intensity, 1, 0, 100);
  light.diffuse = color(data?.color, [1, 1, 1]);
  return light;
}

/** Behaviours are bounded, declarative and data-only (no creator code runs here; see W17/W18). */
function behave(behavior, deltaSeconds) {
  const { node, data, origin } = behavior;
  behavior.time += deltaSeconds;
  const speed = num(data.speed, 1, -100, 100);
  if (data.kind === 'spin') node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), behavior.time * speed).multiply(behavior.baseRotation);
  else if (data.kind === 'bob') node.position.y = origin.y + Math.sin(behavior.time * speed) * num(data.amplitude, 0.25, 0, 100);
  else if (data.kind === 'orbit') {
    const radius = num(data.radius, 2, 0, 1000);
    node.position.x = origin.x + Math.cos(behavior.time * speed) * radius;
    node.position.z = origin.z + Math.sin(behavior.time * speed) * radius;
    node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), -behavior.time * speed);
  }
}

export function createBabylonRenderer(scene, { render = true } = {}) {
  return {
    async mount(world, entities, signal) {
      const handle = { worldId: world.id, nodes: new Map(), meshes: [], materials: [], lights: [], behaviors: [], spawn: null, floors: [], sounds: [], disposed: false };
      try {
        for (const [index, entity] of entities.entries()) {
          if (signal.aborted) throw new Error('mount aborted');
          const node = new TransformNode(`${world.id}:${entity.id}`, scene);
          handle.nodes.set(entity.id, node);
          node.position = vec(entity.transform.position);
          node.rotationQuaternion = new Quaternion(...entity.transform.rotation);
          node.scaling = vec(entity.transform.scale);
          if (entity.parent) node.parent = handle.nodes.get(entity.parent) ?? null;
          const c = entity.components;
          if (c.mesh) {
            const mesh = createMesh(`${world.id}:${entity.id}:mesh`, c.mesh.data, scene);
            mesh.parent = node;
            mesh.metadata = { entityId: entity.id };
            if (c.material) {
              const material = new StandardMaterial(`${world.id}:${entity.id}:material`, scene);
              material.diffuseColor = color(c.material.data?.color);
              material.emissiveColor = color(c.material.data?.emissive, [0, 0, 0]);
              material.specularColor = new Color3(0.1, 0.1, 0.1);
              if (typeof c.material.data?.alpha === 'number') material.alpha = num(c.material.data.alpha, 1, 0, 1);
              mesh.material = material;
              handle.materials.push(material);
            }
            if (c.collider) { mesh.checkCollisions = true; if (c.collider.data?.floor) handle.floors.push(mesh); }
            else mesh.isPickable = false;
            handle.meshes.push(mesh);
          }
          if (c.light) { const light = createLight(`${world.id}:${entity.id}:light`, c.light.data, scene); if (light instanceof PointLight) light.parent = node; handle.lights.push(light); }
          if (c.behavior && typeof c.behavior.data?.kind === 'string') {
            handle.behaviors.push({ node, data: c.behavior.data, origin: node.position.clone(), baseRotation: node.rotationQuaternion.clone(), time: 0 });
          }
          if (c.spawn && !handle.spawn) handle.spawn = { entityId: entity.id, node };
          if (c.audio) handle.sounds.push({ entityId: entity.id, node, data: c.audio.data });
          if (index % 64 === 63) await new Promise(resolve => setTimeout(resolve, 0)); // yield and observe cancellation
        }
        return handle;
      } catch (error) {
        this.unmount(handle);
        throw error;
      }
    },
    unmount(handle) {
      if (handle.disposed) return;
      handle.disposed = true;
      for (const light of handle.lights) light.dispose();
      for (const mesh of handle.meshes) mesh.dispose(false, false);
      for (const material of handle.materials) material.dispose(true, true);
      for (const node of [...handle.nodes.values()].reverse()) node.dispose(true);
      handle.nodes.clear();
      handle.meshes.length = handle.materials.length = handle.lights.length = handle.behaviors.length = handle.floors.length = handle.sounds.length = 0;
    },
    renderFrame(handle, deltaSeconds) {
      for (const behavior of handle.behaviors) behave(behavior, deltaSeconds);
      if (render) scene.render();
    }
  };
}

/** Frame scheduler on Babylon's engine loop so immersive WebXR sessions drive frames on headsets. */
export function createEngineScheduler(engine, now = () => performance.now()) {
  const queue = new Map();
  let next = 0;
  let running = false;
  const loop = () => {
    const callbacks = [...queue.values()];
    queue.clear();
    const time = now();
    for (const callback of callbacks) callback(time);
    if (queue.size === 0) { engine.stopRenderLoop(loop); running = false; }
  };
  return {
    request(callback) { queue.set(++next, callback); if (!running) { running = true; engine.runRenderLoop(loop); } return next; },
    cancel(id) { queue.delete(id); }
  };
}

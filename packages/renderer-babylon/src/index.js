// Babylon.js RendererPort adapter for the provisionally selected foundation (F06/W03).
// Maps validated engine world entities to Babylon scene resources, loads
// canonical glTF/GLB assets through @babylonjs/loaders, and releases every
// resource it created on unmount.
import { TransformNode, MeshBuilder, StandardMaterial, Color3, Vector3, Quaternion, HemisphericLight, PointLight, DirectionalLight, LoadAssetContainerAsync } from '@babylonjs/core';
import '@babylonjs/loaders/glTF/index.js';

export const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const MODEL_TYPES = new Set(['model/gltf-binary', 'model/gltf+json']);

/**
 * Validate a canonical model before handing it to the loader (A04 subset):
 * size bound, GLB header/version and, for JSON glTF, self-contained data-URI
 * buffers/images only (no network fetches from inside an asset).
 */
export function inspectModel(bytes, mediaType) {
  if (!MODEL_TYPES.has(mediaType)) throw new Error(`Unsupported model media type ${mediaType}`);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('Model bytes are empty');
  if (bytes.byteLength > MAX_MODEL_BYTES) throw new Error(`Model exceeds ${MAX_MODEL_BYTES} bytes`);
  if (mediaType === 'model/gltf-binary') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('GLB magic header missing');
    if (view.getUint32(4, true) !== 2) throw new Error('Only glTF 2.0 GLB is supported');
    if (view.getUint32(8, true) !== bytes.byteLength) throw new Error('GLB length field does not match the data');
    return { kind: 'glb' };
  }
  let json;
  try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('glTF JSON is malformed'); }
  if (json?.asset?.version !== '2.0') throw new Error('Only glTF 2.0 is supported');
  for (const list of [json.buffers ?? [], json.images ?? []]) for (const item of list) {
    if (item.uri !== undefined && !String(item.uri).startsWith('data:')) throw new Error(`External glTF resource "${String(item.uri).slice(0, 60)}" must be imported through the asset pipeline`);
  }
  const supported = new Set(['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_materials_emissive_strength', 'KHR_mesh_quantization']);
  for (const extension of json.extensionsRequired ?? []) if (!supported.has(extension)) throw new Error(`Required glTF extension ${extension} is not supported`);
  return { kind: 'gltf', animations: (json.animations ?? []).length, skins: (json.skins ?? []).length };
}

async function loadModel(scene, bytes, mediaType, name) {
  const info = inspectModel(bytes, mediaType);
  const source = info.kind === 'glb' ? bytes : `data:${new TextDecoder().decode(bytes)}`;
  const container = await LoadAssetContainerAsync(source, scene, { pluginExtension: info.kind === 'glb' ? '.glb' : '.gltf', name });
  return container;
}

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

/**
 * @param scene Babylon scene (right-handed for engine worlds)
 * @param options.loadAsset async (world, assetId) => { bytes: Uint8Array, mediaType } for 'model' components
 */
export function createBabylonRenderer(scene, { render = true, loadAsset = null } = {}) {
  return {
    async mount(world, entities, signal) {
      const handle = { worldId: world.id, nodes: new Map(), meshes: [], materials: [], lights: [], behaviors: [], spawn: null, floors: [], sounds: [], containers: [], animations: [], disposed: false };
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
          if (c.model) {
            const source = typeof c.model.data?.source === 'string' && c.model.data.source.startsWith('asset:') ? c.model.data.source.slice(6) : null;
            const asset = source && world.assets.find(item => item.id === source);
            if (!asset) throw new Error(`Model on ${entity.id} needs an asset:<id> source`);
            if (!loadAsset) throw new Error('This renderer was created without an asset loader');
            const { bytes, mediaType } = await loadAsset(world, asset.id);
            if (signal.aborted) throw new Error('mount aborted');
            const container = await loadModel(scene, bytes, mediaType ?? asset.mediaType, `${world.id}:${entity.id}:model`);
            handle.containers.push(container);
            if (signal.aborted) throw new Error('mount aborted');
            container.addAllToScene();
            for (const root of container.rootNodes) root.parent = node;
            for (const mesh of container.meshes) { mesh.metadata = { entityId: entity.id }; if (c.collider) mesh.checkCollisions = true; }
            const clip = typeof c.model.data?.animation === 'string' ? container.animationGroups.find(g => g.name === c.model.data.animation) : container.animationGroups[0];
            if (clip && c.model.data?.autoplay !== false) { clip.start(true); handle.animations.push(clip); }
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
      for (const group of handle.animations) group.stop();
      for (const container of handle.containers) { container.removeAllFromScene(); container.dispose(); }
      for (const light of handle.lights) light.dispose();
      for (const mesh of handle.meshes) mesh.dispose(false, false);
      for (const material of handle.materials) material.dispose(true, true);
      for (const node of [...handle.nodes.values()].reverse()) node.dispose(true);
      handle.nodes.clear();
      handle.meshes.length = handle.materials.length = handle.lights.length = handle.behaviors.length = handle.floors.length = handle.sounds.length = handle.containers.length = handle.animations.length = 0;
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

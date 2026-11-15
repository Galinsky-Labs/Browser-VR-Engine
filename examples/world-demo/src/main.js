// Runnable example world: desktop (keyboard/mouse/touch) and WebXR-capable.
// Uses only local services; no account, application API or media server.
import { Engine, Scene, UniversalCamera, Vector3, Color4, WebXRDefaultExperience } from '@babylonjs/core';
import { createRuntime, createLocalServices, bindVisibility } from '@browser-vr-engine/runtime';
import { createBabylonRenderer, createEngineScheduler } from './babylon-renderer.js';
import { WORLDS } from './worlds.js';
import { createSpatialAudio } from './spatial-audio.js';

const canvas = document.getElementById('scene');
const status = document.getElementById('status');
const worldSelect = document.getElementById('world');
const soundButton = document.getElementById('sound');
const xrStatus = document.getElementById('xr');

const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: true, xrCompatible: true });
const scene = new Scene(engine);
// Engine worlds are right-handed, Y-up, in meters (W01 invariant).
scene.useRightHandedSystem = true;
scene.clearColor = new Color4(0.62, 0.78, 0.95, 1);
scene.gravity = new Vector3(0, -0.4, 0);
scene.collisionsEnabled = true;

const camera = new UniversalCamera('player', new Vector3(0, 1.7, 9), scene);
camera.setTarget(new Vector3(0, 1.7, 0));
camera.attachControl(canvas, true);
camera.minZ = 0.05;
camera.speed = 0.18;
camera.angularSensibility = 3000;
camera.applyGravity = true;
camera.checkCollisions = true;
camera.ellipsoid = new Vector3(0.35, 0.85, 0.35);
camera.keysUp.push(87); camera.keysDown.push(83); camera.keysLeft.push(65); camera.keysRight.push(68);

let storage = null;
try { storage = window.localStorage; storage.getItem('probe'); } catch { storage = null; }
const services = createLocalServices({ capabilities: ['world:load:local', 'persistence:local'], ...(storage ? { storage } : {}) });
const renderer = createBabylonRenderer(scene);
const runtime = createRuntime({ renderer, services, scheduler: createEngineScheduler(engine) });
const audio = createSpatialAudio();
let xr = null;

runtime.on(event => {
  if (event.type === 'state') document.body.dataset.state = event.to;
  if (event.type === 'load-failed') status.textContent = `Load failed: ${event.error.message}`;
});

// Audio follows the active world's emitters and the active (desktop or XR) camera.
let frameCounter = 0;
const renderFrame = renderer.renderFrame.bind(renderer);
renderer.renderFrame = (handle, dt) => {
  renderFrame(handle, dt);
  const active = scene.activeCamera ?? camera;
  audio.update(active.globalPosition ?? active.position, active.getForwardRay(1).direction, handle.sounds);
  if (frameCounter++ % 30 === 0) status.textContent = `${runtime.world?.name ?? '-'} | ${Number.isFinite(engine.getFps()) ? engine.getFps().toFixed(0) : '–'} fps | ${runtime.state}`;
};

async function loadWorld(id) {
  const factory = WORLDS[id] ?? WORLDS.courtyard;
  status.textContent = `Loading ${id}…`;
  await runtime.load(factory());
  const spawn = scene.getTransformNodeByName(`${id}:spawn`);
  if (spawn) { camera.position.copyFrom(spawn.position); camera.setTarget(spawn.position.add(new Vector3(0, 0, -1))); }
  if (runtime.state === 'loaded') runtime.start();
  audio.reset();
  if (xr?.teleportation) {
    xr.teleportation.removeFloorMeshes?.();
    const floors = scene.meshes.filter(mesh => mesh.name.startsWith(`${id}:`) && mesh.checkCollisions && mesh.name.match(/ground|floor|plaza/));
    for (const floor of floors) xr.teleportation.addFloorMesh(floor);
  }
  await services.persistence.save('last-world', id).catch(() => {});
  document.body.dataset.world = id;
  window.__bvrDemo = { ready: true, world: id, meshes: scene.meshes.length, state: runtime.state };
}

async function setupXR() {
  if (!navigator.xr) { xrStatus.textContent = 'WebXR not available in this browser (desktop mode).'; return; }
  let supported = false;
  try { supported = await navigator.xr.isSessionSupported('immersive-vr'); } catch { supported = false; }
  if (!supported) { xrStatus.textContent = 'WebXR present; no immersive-vr device detected.'; return; }
  const floors = scene.meshes.filter(mesh => mesh.checkCollisions && /ground|floor|plaza/.test(mesh.name));
  xr = await WebXRDefaultExperience.CreateAsync(scene, { floorMeshes: floors, disableTeleportation: false });
  xrStatus.textContent = 'Immersive VR available: use the headset button (bottom right). Unverified on physical headsets.';
  xr.baseExperience.onStateChangedObservable.add(state => { document.body.dataset.xr = String(state); });
}

worldSelect.addEventListener('change', () => { loadWorld(worldSelect.value).catch(error => { status.textContent = error.message; }); });
soundButton.addEventListener('click', () => { const on = audio.toggle(); soundButton.textContent = on ? 'Sound: on' : 'Sound: off'; soundButton.setAttribute('aria-pressed', String(on)); });
window.addEventListener('resize', () => engine.resize());
bindVisibility(runtime, document);

const last = await services.persistence.load('last-world').catch(() => null);
const initial = new URLSearchParams(location.search).get('world') ?? last ?? 'courtyard';
worldSelect.value = WORLDS[initial] ? initial : 'courtyard';
await loadWorld(worldSelect.value);
await setupXR().catch(error => { xrStatus.textContent = `WebXR setup failed: ${error.message}`; });

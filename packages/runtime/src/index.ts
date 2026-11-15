/**
 * Runtime lifecycle and injectable local services (W02).
 *
 * The runtime owns scene lifecycle only. Rendering resources live behind a
 * RendererPort (the selected foundation's adapter, e.g. Babylon.js), and host
 * application UI stays outside. Local mode grants only explicit local
 * capabilities; it never silently authorizes a remote world.
 */
import { assertWorld, expandPrefabs, migrateWorld, type Entity, type ValidateOptions, type WorldDocument } from '@browser-vr-engine/world';

export type LifecycleState = 'created' | 'loading' | 'loaded' | 'running' | 'suspended' | 'disposed';

export interface RendererPort<Handle = unknown> {
  /** Create rendering resources for a validated, prefab-expanded world. Must honour the abort signal. */
  mount(world: WorldDocument, entities: readonly Entity[], signal: AbortSignal): Promise<Handle>;
  /** Release every resource created by mount. Must be idempotent per handle. */
  unmount(handle: Handle): void;
  renderFrame(handle: Handle, deltaSeconds: number): void;
}

export interface FrameScheduler {
  request(callback: (timeMs: number) => void): number;
  cancel(id: number): void;
}

export interface AssetService {
  /** Resolve a bundle-relative asset to a fetchable URL inside the host's trust boundary. */
  resolve(world: WorldDocument, assetId: string): string;
}

export interface AuthorizationService {
  authorize(action: 'world:load', world: WorldDocument): boolean | Promise<boolean>;
}

export interface PersistenceService {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
}

export interface TransportService {
  readonly kind: 'none' | 'local' | 'remote';
  send(channel: string, message: unknown): void;
  subscribe(channel: string, listener: (message: unknown) => void): () => void;
}

export interface RuntimeServices {
  assets: AssetService;
  authorization: AuthorizationService;
  persistence: PersistenceService;
  transport: TransportService;
}

export type LocalCapability = 'world:load:local' | 'world:load:remote' | 'persistence:local' | 'transport:local';

export interface LocalServiceOptions {
  capabilities: readonly LocalCapability[];
  /** Remote world ids the host explicitly trusts when 'world:load:remote' is granted. */
  trustedRemoteWorlds?: readonly string[];
  assetBase?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

/** Local implementations for standalone hosts with no account, application API or media server. */
export function createLocalServices(options: LocalServiceOptions): RuntimeServices {
  const granted = new Set(options.capabilities);
  const trusted = new Set(options.trustedRemoteWorlds ?? []);
  const memory = new Map<string, string>();
  const listeners = new Map<string, Set<(message: unknown) => void>>();
  const base = options.assetBase ?? './';
  return {
    assets: {
      resolve(world, assetId) {
        const asset = world.assets.find(item => item.id === assetId);
        if (!asset) throw new Error(`Unknown asset "${assetId}" in world "${world.id}"`);
        return asset.uri.startsWith('sha256:') ? `${base}cas/${asset.uri.slice(7)}` : `${base}${asset.uri}`;
      }
    },
    authorization: {
      authorize(action, world) {
        if (action !== 'world:load') return false;
        if (world.origin === 'local') return granted.has('world:load:local');
        return granted.has('world:load:remote') && trusted.has(world.id);
      }
    },
    persistence: {
      async load(key) {
        if (!granted.has('persistence:local')) throw new Error('persistence:local capability not granted');
        return options.storage ? options.storage.getItem(`bvr:${key}`) : memory.get(key) ?? null;
      },
      async save(key, value) {
        if (!granted.has('persistence:local')) throw new Error('persistence:local capability not granted');
        if (options.storage) options.storage.setItem(`bvr:${key}`, value); else memory.set(key, value);
      }
    },
    transport: {
      kind: granted.has('transport:local') ? 'local' : 'none',
      send(channel, message) {
        if (!granted.has('transport:local')) throw new Error('transport:local capability not granted');
        for (const listener of [...(listeners.get(channel) ?? [])]) listener(structuredClone(message));
      },
      subscribe(channel, listener) {
        if (!granted.has('transport:local')) throw new Error('transport:local capability not granted');
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => { set.delete(listener); };
      }
    }
  };
}

export type RuntimeEvent =
  | { type: 'state'; from: LifecycleState; to: LifecycleState }
  | { type: 'loaded'; worldId: string; entities: number }
  | { type: 'load-cancelled'; worldId: string }
  | { type: 'load-failed'; worldId: string | null; error: Error }
  | { type: 'unloaded'; worldId: string };

export interface RuntimeOptions<Handle> {
  renderer: RendererPort<Handle>;
  services: RuntimeServices;
  scheduler: FrameScheduler;
  validation?: ValidateOptions;
}

export class LoadCancelledError extends Error {
  constructor(worldId: string) { super(`Load of world "${worldId}" was superseded or cancelled`); this.name = 'LoadCancelledError'; }
}

export interface Runtime {
  readonly state: LifecycleState;
  readonly world: WorldDocument | null;
  /** Number of scheduled frame loops; always 0 or 1. */
  readonly activeFrameLoops: number;
  readonly frames: number;
  load(input: WorldDocument | string): Promise<WorldDocument>;
  start(): void;
  suspend(): void;
  resume(): void;
  unload(): void;
  dispose(): void;
  on(listener: (event: RuntimeEvent) => void): () => void;
}

export function createRuntime<Handle>(options: RuntimeOptions<Handle>): Runtime {
  const { renderer, services, scheduler } = options;
  let state: LifecycleState = 'created';
  let world: WorldDocument | null = null;
  let handle: Handle | null = null;
  let pending: AbortController | null = null;
  let generation = 0;
  let frameId: number | null = null;
  let lastTime: number | null = null;
  let frames = 0;
  const listeners = new Set<(event: RuntimeEvent) => void>();

  const emit = (event: RuntimeEvent) => { for (const listener of [...listeners]) { try { listener(event); } catch { /* listener faults never break lifecycle */ } } };
  const transition = (to: LifecycleState) => { if (to !== state) { const from = state; state = to; emit({ type: 'state', from, to }); } };
  const alive = () => { if (state === 'disposed') throw new Error('Runtime is disposed'); };

  const tick = (time: number) => {
    frameId = null;
    if (state !== 'running' || handle === null) return;
    const delta = lastTime === null ? 0 : Math.min(0.1, Math.max(0, (time - lastTime) / 1000));
    lastTime = time;
    frames++;
    renderer.renderFrame(handle, delta);
    if (state === 'running' && frameId === null) frameId = scheduler.request(tick);
  };
  const startLoop = () => { if (frameId === null) { lastTime = null; frameId = scheduler.request(tick); } };
  const stopLoop = () => { if (frameId !== null) { scheduler.cancel(frameId); frameId = null; } };

  const release = () => {
    stopLoop();
    if (handle !== null) { const old = handle; handle = null; renderer.unmount(old); }
    if (world) { const id = world.id; world = null; emit({ type: 'unloaded', worldId: id }); }
  };

  return {
    get state() { return state; },
    get world() { return world; },
    get activeFrameLoops() { return frameId === null ? 0 : 1; },
    get frames() { return frames; },
    async load(input) {
      alive();
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const mine = ++generation;
      let candidate: WorldDocument | null = null;
      const wasRunning = state === 'running';
      transition('loading');
      try {
        const parsed = typeof input === 'string' ? JSON.parse(input) as unknown : input;
        candidate = assertWorld(migrateWorld(parsed), options.validation);
        if (!(await services.authorization.authorize('world:load', candidate))) {
          throw new Error(`Not authorized to load ${candidate.origin} world "${candidate.id}"`);
        }
        if (controller.signal.aborted) throw new LoadCancelledError(candidate.id);
        const entities = expandPrefabs(candidate);
        const next = await renderer.mount(candidate, entities, controller.signal);
        if (controller.signal.aborted || mine !== generation || (state as LifecycleState) === 'disposed') {
          renderer.unmount(next); // late result of a superseded load: dispose, never publish
          throw new LoadCancelledError(candidate.id);
        }
        release();
        handle = next;
        world = candidate;
        pending = null;
        transition('loaded');
        emit({ type: 'loaded', worldId: candidate.id, entities: entities.length });
        if (wasRunning) { transition('running'); startLoop(); }
        return candidate;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err instanceof LoadCancelledError) emit({ type: 'load-cancelled', worldId: candidate?.id ?? 'unknown' });
        else emit({ type: 'load-failed', worldId: candidate?.id ?? null, error: err });
        if (mine === generation && state !== 'disposed') {
          pending = null;
          transition(handle !== null ? (wasRunning ? 'running' : 'loaded') : 'created');
          if (wasRunning && handle !== null) startLoop();
        }
        throw err;
      }
    },
    start() {
      alive();
      if (handle === null || (state !== 'loaded' && state !== 'running')) throw new Error(`Cannot start from state ${state}`);
      transition('running');
      startLoop();
    },
    suspend() {
      alive();
      if (state !== 'running') return;
      stopLoop();
      transition('suspended');
    },
    resume() {
      alive();
      if (state !== 'suspended') return;
      transition('running');
      startLoop();
    },
    unload() {
      alive();
      pending?.abort();
      pending = null;
      generation++;
      release();
      transition('created');
    },
    dispose() {
      if (state === 'disposed') return;
      pending?.abort();
      pending = null;
      generation++;
      release();
      transition('disposed');
      listeners.clear();
    },
    on(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
}

/** Suspend while the document is hidden and resume when it becomes visible again. */
export function bindVisibility(runtime: Runtime, target: { readonly hidden: boolean; addEventListener(type: 'visibilitychange', cb: () => void): void; removeEventListener(type: 'visibilitychange', cb: () => void): void }): () => void {
  const onChange = () => { if (target.hidden) runtime.suspend(); else runtime.resume(); };
  target.addEventListener('visibilitychange', onChange);
  return () => target.removeEventListener('visibilitychange', onChange);
}

/** Desktop/touch/accessible action input (W04 subset): maps keys to named actions. */
export type Action = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'interact' | 'menu';
export const DEFAULT_KEY_BINDINGS: Readonly<Record<string, Action>> = Object.freeze({
  KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right', Space: 'jump', KeyE: 'interact', Enter: 'interact', Escape: 'menu'
});

export class ActionState {
  readonly #active = new Set<Action>();
  readonly #bindings: Map<string, Action>;
  #axis = { x: 0, z: 0 };
  constructor(bindings: Readonly<Record<string, Action>> = DEFAULT_KEY_BINDINGS) { this.#bindings = new Map(Object.entries(bindings)); }
  keyDown(code: string): Action | null { const action = this.#bindings.get(code) ?? null; if (action) this.#active.add(action); return action; }
  keyUp(code: string): Action | null { const action = this.#bindings.get(code) ?? null; if (action) this.#active.delete(action); return action; }
  press(action: Action): void { this.#active.add(action); }
  release(action: Action): void { this.#active.delete(action); }
  clear(): void { this.#active.clear(); this.#axis = { x: 0, z: 0 }; }
  has(action: Action): boolean { return this.#active.has(action); }
  /** Current bindings, grouped by action, for an accessible controls panel. */
  bindings(): Record<Action, string[]> {
    const out = {} as Record<Action, string[]>;
    for (const [code, action] of this.#bindings) (out[action] ??= []).push(code);
    return out;
  }
  /**
   * Remap a key. Returns the action the key previously had (so a UI can warn),
   * and refuses to remove the last binding of 'menu' so users cannot lock
   * themselves out of the settings.
   */
  rebind(code: string, action: Action): Action | null {
    if (!/^[A-Za-z0-9]{1,24}$/.test(code)) throw new Error('Invalid key code');
    const previous = this.#bindings.get(code) ?? null;
    if (previous === 'menu' && action !== 'menu' && [...this.#bindings.values()].filter(a => a === 'menu').length === 1) throw new Error('At least one key must open the menu');
    this.#bindings.set(code, action);
    return previous === action ? null : previous;
  }
  unbind(code: string): void {
    if (this.#bindings.get(code) === 'menu' && [...this.#bindings.values()].filter(a => a === 'menu').length === 1) throw new Error('At least one key must open the menu');
    this.#bindings.delete(code);
  }
  /** Analog input from a touch joystick or gamepad, clamped to the unit disc. x = right, z = forward. */
  setAxis(x: number, z: number): void {
    const fx = Number.isFinite(x) ? x : 0;
    const fz = Number.isFinite(z) ? z : 0;
    const length = Math.hypot(fx, fz);
    this.#axis = length > 1 ? { x: fx / length, z: fz / length } : { x: fx, z: fz };
  }
  /** Planar movement intent in the local frame: digital keys and analog axis combined, magnitude ≤ 1. */
  movement(): { x: number; z: number } {
    const x = (this.has('right') ? 1 : 0) - (this.has('left') ? 1 : 0) + this.#axis.x;
    const z = (this.has('forward') ? 1 : 0) - (this.has('back') ? 1 : 0) + this.#axis.z;
    const length = Math.hypot(x, z);
    return length > 1 ? { x: x / length, z: z / length } : { x: x === 0 ? 0 : x, z: z === 0 ? 0 : z };
  }
}

/** Gamepad mapping (standard layout) with a radial dead zone. Returns axis and pressed actions. */
export function readGamepad(axes: readonly number[], buttons: readonly { pressed: boolean }[], deadZone = 0.15): { x: number; z: number; actions: Action[] } {
  const rx = axes[0] ?? 0;
  const rz = -(axes[1] ?? 0);
  const magnitude = Math.hypot(rx, rz);
  const scale = magnitude <= deadZone ? 0 : Math.min(1, (magnitude - deadZone) / (1 - deadZone)) / magnitude;
  const actions: Action[] = [];
  if (buttons[0]?.pressed) actions.push('jump');
  if (buttons[2]?.pressed) actions.push('interact');
  if (buttons[9]?.pressed) actions.push('menu');
  return { x: rx * scale || 0, z: rz * scale || 0, actions };
}

/** VR comfort settings (W05). Defaults follow the user's reduced-motion preference. */
export interface ComfortSettings {
  locomotion: 'teleport' | 'smooth';
  turn: 'snap' | 'smooth';
  snapDegrees: 15 | 30 | 45 | 90;
  smoothTurnDegreesPerSecond: number;
  vignette: boolean;
  seated: boolean;
  /** Added to the tracked height when seated, meters. */
  seatedHeightOffset: number;
}

export function comfortDefaults(prefersReducedMotion: boolean): ComfortSettings {
  return prefersReducedMotion
    ? { locomotion: 'teleport', turn: 'snap', snapDegrees: 45, smoothTurnDegreesPerSecond: 60, vignette: true, seated: false, seatedHeightOffset: 0 }
    : { locomotion: 'teleport', turn: 'snap', snapDegrees: 30, smoothTurnDegreesPerSecond: 90, vignette: true, seated: false, seatedHeightOffset: 0 };
}

export function validateComfort(input: unknown, fallback: ComfortSettings): ComfortSettings {
  const value = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof ComfortSettings, unknown>>;
  return {
    locomotion: value.locomotion === 'smooth' || value.locomotion === 'teleport' ? value.locomotion : fallback.locomotion,
    turn: value.turn === 'smooth' || value.turn === 'snap' ? value.turn : fallback.turn,
    snapDegrees: [15, 30, 45, 90].includes(value.snapDegrees as number) ? value.snapDegrees as ComfortSettings['snapDegrees'] : fallback.snapDegrees,
    smoothTurnDegreesPerSecond: typeof value.smoothTurnDegreesPerSecond === 'number' && value.smoothTurnDegreesPerSecond >= 10 && value.smoothTurnDegreesPerSecond <= 180 ? value.smoothTurnDegreesPerSecond : fallback.smoothTurnDegreesPerSecond,
    vignette: typeof value.vignette === 'boolean' ? value.vignette : fallback.vignette,
    seated: typeof value.seated === 'boolean' ? value.seated : fallback.seated,
    seatedHeightOffset: typeof value.seatedHeightOffset === 'number' && value.seatedHeightOffset >= 0 && value.seatedHeightOffset <= 1 ? value.seatedHeightOffset : fallback.seatedHeightOffset
  };
}

/** Apply a turn input to a yaw (radians). Snap turns fire once per stick deflection. */
export function applyTurn(yaw: number, input: number, settings: ComfortSettings, deltaSeconds: number, state: { latched: boolean }): number {
  const twoPi = Math.PI * 2;
  let next = yaw;
  if (settings.turn === 'snap') {
    if (Math.abs(input) >= 0.7 && !state.latched) { next += Math.sign(input) * settings.snapDegrees * Math.PI / 180; state.latched = true; }
    else if (Math.abs(input) < 0.3) state.latched = false;
  } else if (Math.abs(input) > 0.15) {
    next += input * settings.smoothTurnDegreesPerSecond * Math.PI / 180 * Math.min(0.1, Math.max(0, deltaSeconds));
  }
  return ((next % twoPi) + twoPi) % twoPi;
}

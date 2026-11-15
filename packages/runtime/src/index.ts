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
  readonly #bindings: Readonly<Record<string, Action>>;
  constructor(bindings: Readonly<Record<string, Action>> = DEFAULT_KEY_BINDINGS) { this.#bindings = bindings; }
  keyDown(code: string): Action | null { const action = this.#bindings[code] ?? null; if (action) this.#active.add(action); return action; }
  keyUp(code: string): Action | null { const action = this.#bindings[code] ?? null; if (action) this.#active.delete(action); return action; }
  press(action: Action): void { this.#active.add(action); }
  release(action: Action): void { this.#active.delete(action); }
  clear(): void { this.#active.clear(); }
  has(action: Action): boolean { return this.#active.has(action); }
  /** Planar movement intent in the local frame: x = right, z = forward, normalized. */
  movement(): { x: number; z: number } {
    const x = (this.has('right') ? 1 : 0) - (this.has('left') ? 1 : 0);
    const z = (this.has('forward') ? 1 : 0) - (this.has('back') ? 1 : 0);
    const length = Math.hypot(x, z) || 1;
    return { x: x / length, z: z / length };
  }
}

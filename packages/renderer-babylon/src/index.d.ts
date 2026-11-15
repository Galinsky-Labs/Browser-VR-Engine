import type { Scene, Engine, AbstractEngine } from '@babylonjs/core';
import type { RendererPort, FrameScheduler } from '@browser-vr-engine/runtime';
import type { WorldDocument } from '@browser-vr-engine/world';

export declare const MAX_MODEL_BYTES: number;
export declare function inspectModel(bytes: Uint8Array, mediaType: string): { kind: 'glb' } | { kind: 'gltf'; animations: number; skins: number };
export interface BabylonHandle { worldId: string; meshes: unknown[]; floors: unknown[]; sounds: { entityId: string; node: unknown; data: Record<string, unknown> }[]; spawn: { entityId: string; node: unknown } | null; [key: string]: unknown }
export declare function createBabylonRenderer(scene: Scene, options?: { render?: boolean; loadAsset?: ((world: WorldDocument, assetId: string) => Promise<{ bytes: Uint8Array; mediaType?: string }>) | null }): RendererPort<BabylonHandle>;
export declare function createEngineScheduler(engine: Engine | AbstractEngine, now?: () => number): FrameScheduler;

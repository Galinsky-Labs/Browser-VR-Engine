/**
 * Versioned world, entity, prefab and asset-reference schemas (W01).
 *
 * Invariants: meters, right-handed axes, +Y up. Identifiers are stable strings.
 * Unknown optional components are preserved byte-for-byte through a round trip;
 * unknown required components are rejected with an actionable error.
 */

export const WORLD_SCHEMA = 'bvr.world' as const;
export const WORLD_VERSION = 1 as const;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Component {
  /** When true, a runtime that does not know this component type must refuse to load the world. */
  required?: boolean;
  data: JsonValue;
}

export interface PrefabInstance {
  ref: string;
  /** Per-entity component overrides keyed by prefab-local entity id. */
  overrides?: Record<string, Record<string, Component>>;
}

export interface Entity {
  id: string;
  name?: string;
  parent: string | null;
  transform: Transform;
  components: Record<string, Component>;
  prefab?: PrefabInstance;
}

export interface Prefab {
  id: string;
  name?: string;
  entities: Entity[];
}

export interface AssetReference {
  id: string;
  /** Relative path or content-addressed URI. Absolute external URLs are rejected before instantiation. */
  uri: string;
  mediaType: string;
  sha256?: string;
}

export interface WorldDocument {
  schema: typeof WORLD_SCHEMA;
  version: typeof WORLD_VERSION;
  id: string;
  name: string;
  units: 'meters';
  axes: 'right-handed-y-up';
  origin: 'local' | 'remote';
  assets: AssetReference[];
  prefabs: Prefab[];
  entities: Entity[];
}

export interface Limits {
  maxEntities: number;
  maxPrefabs: number;
  maxAssets: number;
  maxDepth: number;
  maxPrefabNesting: number;
  maxComponentBytes: number;
  maxCoordinate: number;
  maxIdLength: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxEntities: 10_000,
  maxPrefabs: 1_000,
  maxAssets: 5_000,
  maxDepth: 64,
  maxPrefabNesting: 8,
  maxComponentBytes: 64 * 1024,
  maxCoordinate: 1_000_000,
  maxIdLength: 128
});

/** Component types this engine version understands. Hosts may register more. */
export const BUILTIN_COMPONENTS: ReadonlySet<string> = new Set([
  'mesh', 'material', 'collider', 'light', 'spawn', 'audio', 'media-surface', 'behavior', 'label', 'asset'
]);

export class WorldValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: string[]) {
    super(`World document is invalid:\n- ${issues.join('\n- ')}`);
    this.name = 'WorldValidationError';
    this.issues = Object.freeze([...issues]);
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkKeys(value: unknown, path: string, issues: string[], depth = 0): void {
  if (depth > 32) { issues.push(`${path}: nesting exceeds 32 levels`); return; }
  if (Array.isArray(value)) { value.forEach((item, index) => checkKeys(item, `${path}[${index}]`, issues, depth + 1)); return; }
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) issues.push(`${path}: forbidden key "${key}"`);
    else checkKeys(value[key], `${path}.${key}`, issues, depth + 1);
  }
}

function finiteVector(value: unknown, length: number, max: number): boolean {
  return Array.isArray(value) && value.length === length && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max);
}

function validId(value: unknown, limits: Limits): value is string {
  return typeof value === 'string' && value.length <= limits.maxIdLength && ID.test(value);
}

function validateTransform(transform: unknown, path: string, limits: Limits, issues: string[]): void {
  if (!isObject(transform)) { issues.push(`${path}.transform must be an object`); return; }
  if (!finiteVector(transform.position, 3, limits.maxCoordinate)) issues.push(`${path}.transform.position must be three finite meters within ±${limits.maxCoordinate}`);
  if (!finiteVector(transform.rotation, 4, 1.000001)) issues.push(`${path}.transform.rotation must be a unit quaternion [x,y,z,w]`);
  else {
    const [x, y, z, w] = transform.rotation as number[] as Quat;
    if (Math.abs(Math.hypot(x, y, z, w) - 1) > 1e-3) issues.push(`${path}.transform.rotation must be normalized`);
  }
  if (!finiteVector(transform.scale, 3, 10_000)) issues.push(`${path}.transform.scale must be three finite factors`);
  else if ((transform.scale as number[]).some(n => n === 0)) issues.push(`${path}.transform.scale must not contain zero (negative scale is allowed)`);
}

function validateComponents(components: unknown, path: string, limits: Limits, known: ReadonlySet<string>, assets: ReadonlySet<string>, issues: string[]): void {
  if (!isObject(components)) { issues.push(`${path}.components must be an object`); return; }
  for (const [type, component] of Object.entries(components)) {
    const where = `${path}.components.${type}`;
    if (!/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/.test(type)) { issues.push(`${where}: invalid component type name`); continue; }
    if (!isObject(component) || !('data' in component)) { issues.push(`${where} must be { required?, data }`); continue; }
    if (component.required !== undefined && typeof component.required !== 'boolean') issues.push(`${where}.required must be boolean`);
    const bytes = new TextEncoder().encode(JSON.stringify(component.data) ?? '').length;
    if (bytes > limits.maxComponentBytes) issues.push(`${where}: ${bytes} bytes exceeds ${limits.maxComponentBytes}`);
    if (!known.has(type) && component.required === true) {
      issues.push(`${where}: required component type "${type}" is not supported by this runtime; register a handler or mark it optional`);
    }
    for (const ref of assetRefs(component.data)) {
      if (!assets.has(ref)) issues.push(`${where}: unresolved asset reference "${ref}"`);
    }
  }
}

/** Asset references inside component data are strings of the form `asset:<id>`. */
function assetRefs(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === 'string' && value.startsWith('asset:')) out.push(value.slice(6));
  else if (Array.isArray(value)) value.forEach(item => assetRefs(item, out, depth + 1));
  else if (isObject(value)) Object.values(value).forEach(item => assetRefs(item, out, depth + 1));
  return out;
}

function validateEntities(entities: unknown, path: string, limits: Limits, known: ReadonlySet<string>, assets: ReadonlySet<string>, prefabs: ReadonlySet<string>, issues: string[]): void {
  if (!Array.isArray(entities)) { issues.push(`${path} must be an array`); return; }
  const ids = new Map<string, Record<string, unknown>>();
  entities.forEach((entity, index) => {
    const where = `${path}[${index}]`;
    if (!isObject(entity)) { issues.push(`${where} must be an object`); return; }
    if (!validId(entity.id, limits)) { issues.push(`${where}.id is not a valid identifier`); return; }
    if (ids.has(entity.id)) issues.push(`${where}: duplicate entity id "${entity.id}"`);
    ids.set(entity.id, entity);
    if (entity.name !== undefined && (typeof entity.name !== 'string' || entity.name.length > 256)) issues.push(`${where}.name must be a short string`);
    validateTransform(entity.transform, where, limits, issues);
    validateComponents(entity.components, where, limits, known, assets, issues);
    if (entity.prefab !== undefined) {
      if (!isObject(entity.prefab) || typeof entity.prefab.ref !== 'string') issues.push(`${where}.prefab.ref must be a prefab id`);
      else if (!prefabs.has(entity.prefab.ref)) issues.push(`${where}: unresolved prefab "${entity.prefab.ref}"`);
    }
  });
  for (const [id, entity] of ids) {
    if (entity.parent === null) continue;
    if (typeof entity.parent !== 'string' || !ids.has(entity.parent)) { issues.push(`${path}: entity "${id}" has unresolved parent "${String(entity.parent)}"`); continue; }
    const seen = new Set<string>([id]);
    let cursor: unknown = entity.parent;
    let depth = 0;
    while (typeof cursor === 'string') {
      if (seen.has(cursor)) { issues.push(`${path}: parent cycle through "${id}"`); break; }
      if (++depth > limits.maxDepth) { issues.push(`${path}: entity "${id}" exceeds hierarchy depth ${limits.maxDepth}`); break; }
      seen.add(cursor);
      cursor = ids.get(cursor)?.parent;
    }
  }
}

export interface ValidateOptions {
  limits?: Partial<Limits>;
  components?: Iterable<string>;
}

/** Validate untrusted input. Returns a list of issues; empty means valid. */
export function validateWorld(input: unknown, options: ValidateOptions = {}): string[] {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const known = new Set([...BUILTIN_COMPONENTS, ...(options.components ?? [])]);
  const issues: string[] = [];
  checkKeys(input, 'world', issues);
  if (issues.length) return issues;
  if (!isObject(input)) return ['world must be an object'];
  if (input.schema !== WORLD_SCHEMA) issues.push(`world.schema must be "${WORLD_SCHEMA}"`);
  if (input.version !== WORLD_VERSION) issues.push(`world.version ${String(input.version)} is not supported; run migrateWorld first`);
  if (!validId(input.id, limits)) issues.push('world.id is not a valid identifier');
  if (typeof input.name !== 'string' || input.name.length > 256) issues.push('world.name must be a short string');
  if (input.units !== 'meters') issues.push('world.units must be "meters"');
  if (input.axes !== 'right-handed-y-up') issues.push('world.axes must be "right-handed-y-up"');
  if (input.origin !== 'local' && input.origin !== 'remote') issues.push('world.origin must be "local" or "remote"');
  const assets = new Set<string>();
  if (!Array.isArray(input.assets) || input.assets.length > limits.maxAssets) issues.push(`world.assets must be an array of at most ${limits.maxAssets}`);
  else input.assets.forEach((asset, index) => {
    const where = `world.assets[${index}]`;
    if (!isObject(asset) || !validId(asset.id, limits)) { issues.push(`${where}.id is not a valid identifier`); return; }
    if (assets.has(asset.id)) issues.push(`${where}: duplicate asset id "${asset.id}"`);
    assets.add(asset.id);
    if (typeof asset.uri !== 'string' || asset.uri.length > 2048) issues.push(`${where}.uri must be a string`);
    else if (/^[a-z][a-z0-9+.-]*:/i.test(asset.uri) && !asset.uri.startsWith('sha256:')) issues.push(`${where}.uri "${asset.uri}" is an external reference; import it through the asset pipeline first`);
    else if (asset.uri.split('/').includes('..') || asset.uri.startsWith('/')) issues.push(`${where}.uri must be a relative path inside the bundle`);
    if (typeof asset.mediaType !== 'string' || !/^[a-z]+\/[A-Za-z0-9.+-]+$/.test(asset.mediaType)) issues.push(`${where}.mediaType is invalid`);
    if (asset.sha256 !== undefined && (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256))) issues.push(`${where}.sha256 must be 64 hex characters`);
  });
  const prefabIds = new Set<string>();
  if (!Array.isArray(input.prefabs) || input.prefabs.length > limits.maxPrefabs) issues.push(`world.prefabs must be an array of at most ${limits.maxPrefabs}`);
  else for (const prefab of input.prefabs) if (isObject(prefab) && validId(prefab.id, limits)) {
    if (prefabIds.has(prefab.id)) issues.push(`world.prefabs: duplicate prefab id "${prefab.id}"`);
    prefabIds.add(prefab.id);
  }
  if (Array.isArray(input.prefabs)) input.prefabs.forEach((prefab, index) => {
    if (!isObject(prefab) || !validId(prefab.id, limits)) { issues.push(`world.prefabs[${index}].id is not a valid identifier`); return; }
    validateEntities(prefab.entities, `world.prefabs[${index}].entities`, limits, known, assets, prefabIds, issues);
  });
  let total = Array.isArray(input.entities) ? input.entities.length : 0;
  if (total > limits.maxEntities) issues.push(`world.entities exceeds ${limits.maxEntities}`);
  validateEntities(input.entities, 'world.entities', limits, known, assets, prefabIds, issues);
  if (!issues.length) {
    try { total = expandPrefabs(input as unknown as WorldDocument, limits).length; } catch (error) { issues.push((error as Error).message); }
    if (total > limits.maxEntities) issues.push(`expanded world has ${total} entities, exceeding ${limits.maxEntities}`);
  }
  return issues;
}

export function assertWorld(input: unknown, options?: ValidateOptions): WorldDocument {
  const issues = validateWorld(input, options);
  if (issues.length) throw new WorldValidationError(issues);
  return input as WorldDocument;
}

/**
 * Expand prefab instances into a flat entity list with stable composite ids
 * `<instanceId>/<prefabEntityId>`. Prefab roots are re-parented under the instance.
 */
export function expandPrefabs(world: WorldDocument, limits: Limits = DEFAULT_LIMITS): Entity[] {
  const prefabs = new Map(world.prefabs.map(prefab => [prefab.id, prefab]));
  const out: Entity[] = [];
  const visit = (entities: Entity[], prefix: string, rootParent: string | null, stack: string[]): void => {
    for (const entity of entities) {
      const id = prefix ? `${prefix}/${entity.id}` : entity.id;
      const parent = entity.parent === null ? rootParent : (prefix ? `${prefix}/${entity.parent}` : entity.parent);
      const { prefab, ...rest } = entity;
      out.push({ ...rest, id, parent, components: { ...entity.components } });
      if (out.length > limits.maxEntities) throw new Error(`expanded world exceeds ${limits.maxEntities} entities`);
      if (prefab) {
        if (stack.includes(prefab.ref)) throw new Error(`prefab cycle: ${[...stack, prefab.ref].join(' -> ')}`);
        if (stack.length >= limits.maxPrefabNesting) throw new Error(`prefab nesting exceeds ${limits.maxPrefabNesting}`);
        const definition = prefabs.get(prefab.ref);
        if (!definition) throw new Error(`unresolved prefab "${prefab.ref}"`);
        const start = out.length;
        visit(definition.entities, id, id, [...stack, prefab.ref]);
        for (const [local, overrides] of Object.entries(prefab.overrides ?? {})) {
          const target = out.slice(start).find(item => item.id === `${id}/${local}`);
          if (!target) throw new Error(`override targets unknown prefab entity "${local}" in "${prefab.ref}"`);
          target.components = { ...target.components, ...overrides };
        }
      }
    }
  };
  visit(world.entities, '', null, []);
  return out;
}

/** Canonical JSON: sorted object keys, no insignificant whitespace. Stable across round trips. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function serializeWorld(world: WorldDocument): string {
  return canonicalize(assertWorld(world));
}

export function parseWorld(text: string, options?: ValidateOptions): WorldDocument {
  if (text.length > 32 * 1024 * 1024) throw new WorldValidationError(['world text exceeds 32 MiB']);
  return assertWorld(migrateWorld(JSON.parse(text)), options);
}

/**
 * Migration hooks. Version 0 (pre-W01 drafts) used `objects` with Euler degrees
 * and an implicit local origin; it migrates to version 1 without losing ids.
 */
export function migrateWorld(input: unknown): unknown {
  if (!isObject(input) || input.schema !== WORLD_SCHEMA) return input;
  if (input.version === 0 && Array.isArray(input.objects)) {
    const entities = input.objects.map(item => {
      const object = isObject(item) ? item : {};
      const [x = 0, y = 0, z = 0] = Array.isArray(object.rotationDegrees) ? object.rotationDegrees as number[] : [];
      return {
        id: object.id,
        ...(object.name === undefined ? {} : { name: object.name }),
        parent: object.parent ?? null,
        transform: { position: object.position ?? [0, 0, 0], rotation: eulerDegreesToQuat(x, y, z), scale: object.scale ?? [1, 1, 1] },
        components: object.components ?? {}
      };
    });
    const { objects: _objects, ...rest } = input;
    return { ...rest, version: 1, origin: input.origin ?? 'local', assets: input.assets ?? [], prefabs: input.prefabs ?? [], entities };
  }
  return input;
}

/** Intrinsic Y-X-Z Euler (degrees) to quaternion, matching common Y-up authoring tools. */
export function eulerDegreesToQuat(x: number, y: number, z: number): Quat {
  const r = Math.PI / 360;
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x * r), Math.sin(x * r), Math.cos(y * r), Math.sin(y * r), Math.cos(z * r), Math.sin(z * r)];
  const q: Quat = [
    cy * sx * cz + sy * cx * sz,
    sy * cx * cz - cy * sx * sz,
    cy * cx * sz - sy * sx * cz,
    cy * cx * cz + sy * sx * sz
  ];
  return q.map(n => Math.abs(n) < 1e-15 ? 0 : n) as Quat;
}

export const IDENTITY_TRANSFORM: Readonly<Transform> = Object.freeze({ position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as Quat, scale: [1, 1, 1] as Vec3 });

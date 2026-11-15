/**
 * Data services (F08): versioned documents, an object store and an idempotent
 * job queue, each scoped to a tenant/project namespace. Memory adapters serve
 * local/offline hosts; Postgres adapters take an injected SQL client so the
 * engine package carries no database driver.
 */

export interface Scope { tenant: string; project: string }

export class StoreError extends Error {
  readonly code: 'not_found' | 'conflict' | 'too_large' | 'invalid' | 'integrity';
  constructor(code: StoreError['code'], message: string) { super(message); this.name = 'StoreError'; this.code = code; }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const KIND = /^[a-z][a-z0-9-]{0,62}$/;
const checkId = (value: string, what: string) => { if (!ID.test(value) || value.includes('..')) throw new StoreError('invalid', `Invalid ${what}`); };

// ---------- documents ----------
export interface StoredDocument { kind: string; id: string; version: number; data: unknown; updatedAt: string }
export interface DocumentStore {
  get(scope: Scope, kind: string, id: string): Promise<StoredDocument | null>;
  /** expectedVersion 0 = create only; otherwise compare-and-swap. */
  put(scope: Scope, kind: string, id: string, data: unknown, expectedVersion: number): Promise<StoredDocument>;
  list(scope: Scope, kind: string, limit?: number): Promise<StoredDocument[]>;
  remove(scope: Scope, kind: string, id: string, expectedVersion: number): Promise<void>;
}

// ---------- objects ----------
export interface ObjectInfo { key: string; size: number; sha256: string; contentType: string; createdAt: string }
export interface ObjectStore {
  put(scope: Scope, key: string, bytes: Uint8Array, contentType: string): Promise<ObjectInfo>;
  get(scope: Scope, key: string): Promise<{ info: ObjectInfo; bytes: Uint8Array } | null>;
  head(scope: Scope, key: string): Promise<ObjectInfo | null>;
  remove(scope: Scope, key: string): Promise<boolean>;
}

// ---------- jobs ----------
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';
export interface Job { id: string; type: string; idempotencyKey: string; state: JobState; input: unknown; result: unknown; error: string | null; attempts: number; maxAttempts: number; leaseUntil: string | null }
export interface JobQueue {
  /** Retries with the same idempotency key return the original job and never enqueue twice. */
  submit(scope: Scope, type: string, idempotencyKey: string, input: unknown, maxAttempts?: number): Promise<{ job: Job; created: boolean }>;
  get(scope: Scope, id: string): Promise<Job | null>;
  /** Claim the oldest runnable job of a type; expired leases are reclaimable. */
  claim(scope: Scope, type: string, leaseSeconds: number): Promise<Job | null>;
  complete(scope: Scope, id: string, result: unknown): Promise<Job>;
  fail(scope: Scope, id: string, error: string): Promise<Job>;
}

export const LIMITS = Object.freeze({ documentBytes: 1024 * 1024, objectBytes: 16 * 1024 * 1024, jobInputBytes: 64 * 1024 });
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? 'null').length;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}

const ns = (scope: Scope) => `${scope.tenant}/${scope.project}`;
const iso = (ms: number) => new Date(ms).toISOString();
const clone = <T>(value: T): T => structuredClone(value);

export function createMemoryStores(now: () => number = () => Date.now()): { documents: DocumentStore; objects: ObjectStore; jobs: JobQueue } {
  const docs = new Map<string, StoredDocument>();
  const objects = new Map<string, { info: ObjectInfo; bytes: Uint8Array }>();
  const jobs = new Map<string, Job & { scope: string; createdAt: number }>();
  let jobCounter = 0;
  const dkey = (scope: Scope, kind: string, id: string) => `${ns(scope)}\u0000${kind}\u0000${id}`;
  return {
    documents: {
      async get(scope, kind, id) { const doc = docs.get(dkey(scope, kind, id)); return doc ? clone(doc) : null; },
      async put(scope, kind, id, data, expectedVersion) {
        if (!KIND.test(kind)) throw new StoreError('invalid', 'Invalid document kind');
        checkId(id, 'document id');
        if (jsonBytes(data) > LIMITS.documentBytes) throw new StoreError('too_large', 'Document exceeds 1 MiB');
        const current = docs.get(dkey(scope, kind, id));
        if ((current?.version ?? 0) !== expectedVersion) throw new StoreError('conflict', `Version conflict: expected ${expectedVersion}, found ${current?.version ?? 0}`);
        const doc = { kind, id, version: expectedVersion + 1, data: clone(data), updatedAt: iso(now()) };
        docs.set(dkey(scope, kind, id), doc);
        return clone(doc);
      },
      async list(scope, kind, limit = 100) {
        const prefix = `${ns(scope)}\u0000${kind}\u0000`;
        return [...docs.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => clone(v)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Math.min(1000, limit));
      },
      async remove(scope, kind, id, expectedVersion) {
        const current = docs.get(dkey(scope, kind, id));
        if (!current) throw new StoreError('not_found', 'Document not found');
        if (current.version !== expectedVersion) throw new StoreError('conflict', 'Version conflict');
        docs.delete(dkey(scope, kind, id));
      }
    },
    objects: {
      async put(scope, key, bytes, contentType) {
        checkId(key, 'object key');
        if (bytes.byteLength > LIMITS.objectBytes) throw new StoreError('too_large', 'Object exceeds 16 MiB');
        const info = { key, size: bytes.byteLength, sha256: await sha256Hex(bytes), contentType, createdAt: iso(now()) };
        objects.set(`${ns(scope)}\u0000${key}`, { info, bytes: bytes.slice() });
        return { ...info };
      },
      async get(scope, key) { const o = objects.get(`${ns(scope)}\u0000${key}`); return o ? { info: { ...o.info }, bytes: o.bytes.slice() } : null; },
      async head(scope, key) { const o = objects.get(`${ns(scope)}\u0000${key}`); return o ? { ...o.info } : null; },
      async remove(scope, key) { return objects.delete(`${ns(scope)}\u0000${key}`); }
    },
    jobs: {
      async submit(scope, type, idempotencyKey, input, maxAttempts = 3) {
        if (!KIND.test(type)) throw new StoreError('invalid', 'Invalid job type');
        checkId(idempotencyKey, 'idempotency key');
        if (jsonBytes(input) > LIMITS.jobInputBytes) throw new StoreError('too_large', 'Job input exceeds 64 KiB');
        const existing = [...jobs.values()].find(job => job.scope === ns(scope) && job.idempotencyKey === idempotencyKey);
        if (existing) {
          if (existing.type !== type || JSON.stringify(existing.input) !== JSON.stringify(input)) throw new StoreError('conflict', 'Idempotency key reused with a different request');
          return { job: strip(existing), created: false };
        }
        const job = { id: `job-${(++jobCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`, type, idempotencyKey, state: 'queued' as JobState, input: clone(input), result: null, error: null, attempts: 0, maxAttempts, leaseUntil: null, scope: ns(scope), createdAt: now() };
        jobs.set(job.id, job);
        return { job: strip(job), created: true };
      },
      async get(scope, id) { const job = jobs.get(id); return job && job.scope === ns(scope) ? strip(job) : null; },
      async claim(scope, type, leaseSeconds) {
        const t = now();
        const job = [...jobs.values()].filter(j => j.scope === ns(scope) && j.type === type && (j.state === 'queued' || (j.state === 'running' && Date.parse(j.leaseUntil!) <= t)) && j.attempts < j.maxAttempts).sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!job) return null;
        job.state = 'running'; job.attempts++; job.leaseUntil = iso(t + leaseSeconds * 1000);
        return strip(job);
      },
      async complete(scope, id, result) { const job = owned(scope, id); job.state = 'succeeded'; job.result = clone(result); job.leaseUntil = null; return strip(job); },
      async fail(scope, id, error) { const job = owned(scope, id); job.error = String(error).slice(0, 2000); job.leaseUntil = null; job.state = job.attempts >= job.maxAttempts ? 'failed' : 'queued'; return strip(job); }
    }
  };
  function owned(scope: Scope, id: string) {
    const job = jobs.get(id);
    if (!job || job.scope !== ns(scope)) throw new StoreError('not_found', 'Job not found');
    if (job.state !== 'running') throw new StoreError('conflict', 'Job is not running');
    return job;
  }
  function strip(job: Job & { scope: string; createdAt: number }): Job { const { scope: _s, createdAt: _c, ...rest } = job; return clone(rest); }
}

// ---------- Postgres ----------
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export interface SqlPool extends SqlClient {
  /** Run work inside one transaction on one connection. */
  transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface Migration { id: string; up: string; down: string }

export const CONTROL_MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    id: '0001_documents',
    up: `CREATE TABLE bvr_documents (tenant text NOT NULL, project text NOT NULL, kind text NOT NULL, id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant, project, kind, id));`,
    down: 'DROP TABLE bvr_documents;'
  },
  {
    id: '0002_objects',
    up: `CREATE TABLE bvr_objects (tenant text NOT NULL, project text NOT NULL, key text NOT NULL, size integer NOT NULL, sha256 text NOT NULL, content_type text NOT NULL, bytes bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant, project, key));`,
    down: 'DROP TABLE bvr_objects;'
  },
  {
    id: '0003_jobs',
    up: `CREATE TABLE bvr_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant text NOT NULL, project text NOT NULL, type text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL, state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed')), input jsonb NOT NULL, result jsonb, error text, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE (tenant, project, idempotency_key));
CREATE INDEX bvr_jobs_runnable ON bvr_jobs (tenant, project, type, created_at) WHERE state IN ('queued','running');`,
    down: 'DROP TABLE bvr_jobs;'
  }
]);

/**
 * Migrate forward or roll back to `target` (a migration id, or null for empty).
 * Each step runs in its own transaction; a failed step rolls back and stops.
 */
export async function migrateControl(pool: SqlPool, options: { target?: string | null; migrations?: readonly Migration[] } = {}): Promise<{ applied: string[]; reverted: string[] }> {
  const migrations = options.migrations ?? CONTROL_MIGRATIONS;
  const targetIndex = options.target === undefined ? migrations.length - 1 : options.target === null ? -1 : migrations.findIndex(m => m.id === options.target);
  if (targetIndex < -1 || (options.target && targetIndex === -1)) throw new StoreError('invalid', `Unknown migration target ${options.target}`);
  await pool.query('CREATE TABLE IF NOT EXISTS bvr_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  return pool.transaction(async lockClient => {
    await lockClient.query('SELECT pg_advisory_xact_lock(4207118)');
    const done = new Set((await lockClient.query('SELECT id FROM bvr_schema_migrations')).rows.map(r => String(r.id)));
    const applied: string[] = [];
    const reverted: string[] = [];
    for (let i = 0; i <= targetIndex; i++) {
      const m = migrations[i]!;
      if (done.has(m.id)) continue;
      await lockClient.query(`SAVEPOINT m${i}`);
      try {
        await lockClient.query(m.up);
        await lockClient.query('INSERT INTO bvr_schema_migrations (id) VALUES ($1)', [m.id]);
        await lockClient.query(`RELEASE SAVEPOINT m${i}`);
        applied.push(m.id);
      } catch (error) {
        await lockClient.query(`ROLLBACK TO SAVEPOINT m${i}`);
        throw new StoreError('invalid', `Migration ${m.id} failed and was rolled back: ${(error as Error).message}`);
      }
    }
    for (let i = migrations.length - 1; i > targetIndex; i--) {
      const m = migrations[i]!;
      if (!done.has(m.id)) continue;
      await lockClient.query(m.down);
      await lockClient.query('DELETE FROM bvr_schema_migrations WHERE id = $1', [m.id]);
      reverted.push(m.id);
    }
    return { applied, reverted };
  });
}

const toIso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);

export function createPostgresStores(pool: SqlPool): { documents: DocumentStore; objects: ObjectStore; jobs: JobQueue } {
  const docRow = (r: Record<string, unknown>): StoredDocument => ({ kind: String(r.kind), id: String(r.id), version: Number(r.version), data: r.data, updatedAt: toIso(r.updated_at) });
  const objInfo = (r: Record<string, unknown>): ObjectInfo => ({ key: String(r.key), size: Number(r.size), sha256: String(r.sha256), contentType: String(r.content_type), createdAt: toIso(r.created_at) });
  const jobRow = (r: Record<string, unknown>): Job => ({ id: String(r.id), type: String(r.type), idempotencyKey: String(r.idempotency_key), state: r.state as JobState, input: r.input, result: r.result ?? null, error: (r.error as string | null) ?? null, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), leaseUntil: r.lease_until ? toIso(r.lease_until) : null });
  return {
    documents: {
      async get(s, kind, id) { const { rows } = await pool.query('SELECT * FROM bvr_documents WHERE tenant=$1 AND project=$2 AND kind=$3 AND id=$4', [s.tenant, s.project, kind, id]); return rows[0] ? docRow(rows[0]) : null; },
      async put(s, kind, id, data, expectedVersion) {
        if (!KIND.test(kind)) throw new StoreError('invalid', 'Invalid document kind');
        checkId(id, 'document id');
        if (jsonBytes(data) > LIMITS.documentBytes) throw new StoreError('too_large', 'Document exceeds 1 MiB');
        const json = JSON.stringify(data);
        const result = expectedVersion === 0
          ? await pool.query('INSERT INTO bvr_documents (tenant, project, kind, id, version, data) VALUES ($1,$2,$3,$4,1,$5::jsonb) ON CONFLICT DO NOTHING RETURNING *', [s.tenant, s.project, kind, id, json])
          : await pool.query('UPDATE bvr_documents SET version = version + 1, data = $6::jsonb, updated_at = now() WHERE tenant=$1 AND project=$2 AND kind=$3 AND id=$4 AND version=$5 RETURNING *', [s.tenant, s.project, kind, id, expectedVersion, json]);
        if (!result.rows[0]) throw new StoreError('conflict', `Version conflict: expected ${expectedVersion}`);
        return docRow(result.rows[0]);
      },
      async list(s, kind, limit = 100) { const { rows } = await pool.query('SELECT * FROM bvr_documents WHERE tenant=$1 AND project=$2 AND kind=$3 ORDER BY id LIMIT $4', [s.tenant, s.project, kind, Math.min(1000, limit)]); return rows.map(docRow); },
      async remove(s, kind, id, expectedVersion) {
        const r = await pool.query('DELETE FROM bvr_documents WHERE tenant=$1 AND project=$2 AND kind=$3 AND id=$4 AND version=$5', [s.tenant, s.project, kind, id, expectedVersion]);
        if (!r.rowCount) { if (await this.get(s, kind, id)) throw new StoreError('conflict', 'Version conflict'); throw new StoreError('not_found', 'Document not found'); }
      }
    },
    objects: {
      async put(s, key, bytes, contentType) {
        checkId(key, 'object key');
        if (bytes.byteLength > LIMITS.objectBytes) throw new StoreError('too_large', 'Object exceeds 16 MiB');
        const sha = await sha256Hex(bytes);
        const { rows } = await pool.query(`INSERT INTO bvr_objects (tenant, project, key, size, sha256, content_type, bytes) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (tenant, project, key) DO UPDATE SET size=EXCLUDED.size, sha256=EXCLUDED.sha256, content_type=EXCLUDED.content_type, bytes=EXCLUDED.bytes, created_at=now() RETURNING key, size, sha256, content_type, created_at`,
          [s.tenant, s.project, key, bytes.byteLength, sha, contentType, bytes]);
        return objInfo(rows[0]!);
      },
      async get(s, key) {
        const { rows } = await pool.query('SELECT * FROM bvr_objects WHERE tenant=$1 AND project=$2 AND key=$3', [s.tenant, s.project, key]);
        if (!rows[0]) return null;
        const bytes = new Uint8Array(rows[0].bytes as ArrayBufferLike);
        const info = objInfo(rows[0]);
        if (await sha256Hex(bytes) !== info.sha256) throw new StoreError('integrity', 'Stored object failed its integrity check');
        return { info, bytes };
      },
      async head(s, key) { const { rows } = await pool.query('SELECT key, size, sha256, content_type, created_at FROM bvr_objects WHERE tenant=$1 AND project=$2 AND key=$3', [s.tenant, s.project, key]); return rows[0] ? objInfo(rows[0]) : null; },
      async remove(s, key) { return Boolean((await pool.query('DELETE FROM bvr_objects WHERE tenant=$1 AND project=$2 AND key=$3', [s.tenant, s.project, key])).rowCount); }
    },
    jobs: {
      async submit(s, type, idempotencyKey, input, maxAttempts = 3) {
        if (!KIND.test(type)) throw new StoreError('invalid', 'Invalid job type');
        checkId(idempotencyKey, 'idempotency key');
        if (jsonBytes(input) > LIMITS.jobInputBytes) throw new StoreError('too_large', 'Job input exceeds 64 KiB');
        const requestHash = await sha256Hex(new TextEncoder().encode(`${type}\u0000${JSON.stringify(input)}`));
        const inserted = await pool.query(`INSERT INTO bvr_jobs (tenant, project, type, idempotency_key, request_hash, state, input, max_attempts) VALUES ($1,$2,$3,$4,$5,'queued',$6::jsonb,$7)
          ON CONFLICT (tenant, project, idempotency_key) DO NOTHING RETURNING *`, [s.tenant, s.project, type, idempotencyKey, requestHash, JSON.stringify(input), maxAttempts]);
        if (inserted.rows[0]) return { job: jobRow(inserted.rows[0]), created: true };
        const { rows } = await pool.query('SELECT * FROM bvr_jobs WHERE tenant=$1 AND project=$2 AND idempotency_key=$3', [s.tenant, s.project, idempotencyKey]);
        if (rows[0]!.request_hash !== requestHash) throw new StoreError('conflict', 'Idempotency key reused with a different request');
        return { job: jobRow(rows[0]!), created: false };
      },
      async get(s, id) {
        if (!/^[0-9a-f-]{36}$/.test(id)) return null;
        const { rows } = await pool.query('SELECT * FROM bvr_jobs WHERE tenant=$1 AND project=$2 AND id=$3', [s.tenant, s.project, id]);
        return rows[0] ? jobRow(rows[0]) : null;
      },
      async claim(s, type, leaseSeconds) {
        const { rows } = await pool.query(`UPDATE bvr_jobs SET state='running', attempts=attempts+1, lease_until=clock_timestamp() + make_interval(secs => $4)
          WHERE id = (SELECT id FROM bvr_jobs WHERE tenant=$1 AND project=$2 AND type=$3 AND attempts < max_attempts AND (state='queued' OR (state='running' AND lease_until <= clock_timestamp()))
                      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [s.tenant, s.project, type, leaseSeconds]);
        return rows[0] ? jobRow(rows[0]) : null;
      },
      async complete(s, id, result) {
        const { rows } = await pool.query("UPDATE bvr_jobs SET state='succeeded', result=$4::jsonb, lease_until=NULL WHERE tenant=$1 AND project=$2 AND id=$3 AND state='running' RETURNING *", [s.tenant, s.project, id, JSON.stringify(result)]);
        if (!rows[0]) throw new StoreError('conflict', 'Job is not running');
        return jobRow(rows[0]);
      },
      async fail(s, id, error) {
        const { rows } = await pool.query("UPDATE bvr_jobs SET state=CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END, error=$4, lease_until=NULL WHERE tenant=$1 AND project=$2 AND id=$3 AND state='running' RETURNING *", [s.tenant, s.project, id, String(error).slice(0, 2000)]);
        if (!rows[0]) throw new StoreError('conflict', 'Job is not running');
        return jobRow(rows[0]);
      }
    }
  };
}

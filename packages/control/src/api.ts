/**
 * Framework-agnostic control API (F08). Hosts adapt their HTTP server to
 * `handle(request)`; tenant and capabilities always come from the verified
 * grant, never from the request path or body.
 */
import { authorize, verifyGrant, GrantError, isNamespace, type Capability, type Grant, type VerifyOptions } from './grants.js';
import { StoreError, type DocumentStore, type JobQueue, type ObjectStore, type Scope } from './stores.js';

export interface ControlRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
  bytes?: Uint8Array;
}
export interface ControlResponse { status: number; headers?: Record<string, string>; body?: unknown; bytes?: Uint8Array }

export interface ControlApiOptions {
  verify: VerifyOptions;
  documents: DocumentStore;
  objects: ObjectStore;
  jobs: JobQueue;
  /** Called after each authorized request (audit hook); must not throw. */
  audit?: (entry: { grant: Grant; method: string; path: string; status: number }) => void;
}

type Handler = (ctx: { grant: Grant; request: ControlRequest; match: RegExpMatchArray; scope: (project: string, cap: Capability) => Scope }) => Promise<ControlResponse>;

const json = (status: number, body: unknown): ControlResponse => ({ status, headers: { 'content-type': 'application/json' }, body });
const PROJECT = '([a-z0-9][a-z0-9-]{0,62})';

export function createControlApi(options: ControlApiOptions) {
  const { documents, objects, jobs } = options;
  const routes: [string, RegExp, Handler][] = [
    ['POST', /^\/v1\/workspaces$/, async ({ grant, request, scope }) => {
      const project = (request.body as { project?: unknown } | undefined)?.project;
      if (!isNamespace(project)) return json(400, { error: 'invalid', message: 'project must be a lowercase namespace' });
      const s = scope(project, 'workspace:create');
      const name = String((request.body as { name?: unknown }).name ?? project).slice(0, 120);
      try {
        const doc = await documents.put(s, 'workspace', 'workspace', { name, createdBy: grant.sub }, 0);
        return json(201, { tenant: s.tenant, project, name, version: doc.version });
      } catch (error) {
        if (error instanceof StoreError && error.code === 'conflict') return json(409, { error: 'conflict', message: 'Workspace already exists' });
        throw error;
      }
    }],
    ['GET', new RegExp(`^/v1/workspaces/${PROJECT}$`), async ({ match, scope }) => {
      const s = scope(match[1]!, 'workspace:read');
      const doc = await documents.get(s, 'workspace', 'workspace');
      return doc ? json(200, { tenant: s.tenant, project: s.project, ...(doc.data as object) }) : json(404, { error: 'not_found' });
    }],
    ['GET', new RegExp(`^/v1/projects/${PROJECT}/documents/([a-z][a-z0-9-]{0,62})/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$`), async ({ match, scope }) => {
      const doc = await documents.get(await workspace(scope(match[1]!, 'document:read')), match[2]!, match[3]!);
      return doc ? json(200, doc) : json(404, { error: 'not_found' });
    }],
    ['PUT', new RegExp(`^/v1/projects/${PROJECT}/documents/([a-z][a-z0-9-]{0,62})/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$`), async ({ match, scope, request }) => {
      const version = Number(request.headers['if-match'] ?? 0);
      if (!Number.isInteger(version) || version < 0) return json(400, { error: 'invalid', message: 'If-Match must be the current version (0 to create)' });
      const doc = await documents.put(await workspace(scope(match[1]!, 'document:write')), match[2]!, match[3]!, request.body, version);
      return json(version === 0 ? 201 : 200, doc);
    }],
    ['PUT', new RegExp(`^/v1/projects/${PROJECT}/objects/([A-Za-z0-9][A-Za-z0-9._/-]{0,199})$`), async ({ match, scope, request }) => {
      if (!request.bytes) return json(400, { error: 'invalid', message: 'Object body required' });
      const info = await objects.put(await workspace(scope(match[1]!, 'object:write')), match[2]!, request.bytes, request.headers['content-type'] ?? 'application/octet-stream');
      return json(201, info);
    }],
    ['GET', new RegExp(`^/v1/projects/${PROJECT}/objects/([A-Za-z0-9][A-Za-z0-9._/-]{0,199})$`), async ({ match, scope }) => {
      const object = await objects.get(await workspace(scope(match[1]!, 'object:read')), match[2]!);
      return object ? { status: 200, headers: { 'content-type': object.info.contentType, etag: `"${object.info.sha256}"`, 'x-content-type-options': 'nosniff', 'content-disposition': 'attachment' }, bytes: object.bytes } : json(404, { error: 'not_found' });
    }],
    ['POST', new RegExp(`^/v1/projects/${PROJECT}/jobs$`), async ({ match, scope, request }) => {
      const key = request.headers['idempotency-key'];
      const body = request.body as { type?: unknown; input?: unknown } | undefined;
      if (!key) return json(400, { error: 'invalid', message: 'Idempotency-Key header required' });
      if (typeof body?.type !== 'string') return json(400, { error: 'invalid', message: 'type required' });
      const { job, created } = await jobs.submit(await workspace(scope(match[1]!, 'job:submit')), body.type, key, body.input ?? null);
      return json(created ? 202 : 200, job);
    }],
    ['GET', new RegExp(`^/v1/projects/${PROJECT}/jobs/([0-9A-Za-z-]{1,64})$`), async ({ match, scope }) => {
      const job = await jobs.get(scope(match[1]!, 'job:read'), match[2]!);
      return job ? json(200, job) : json(404, { error: 'not_found' });
    }]
  ];

  async function workspace(scope: Scope): Promise<Scope> {
    if (!(await documents.get(scope, 'workspace', 'workspace'))) throw new StoreError('not_found', 'Workspace not found');
    return scope;
  }

  return {
    async handle(request: ControlRequest): Promise<ControlResponse> {
      const auth = request.headers.authorization ?? '';
      let grant: Grant;
      try {
        grant = await verifyGrant(auth.startsWith('Bearer ') ? auth.slice(7) : '', options.verify);
      } catch (error) {
        return json(401, { error: error instanceof GrantError ? error.code : 'unauthenticated' });
      }
      const route = routes.find(([method, pattern]) => method === request.method && pattern.test(request.path));
      let response: ControlResponse;
      if (!route) response = json(404, { error: 'not_found' });
      else {
        try {
          response = await route[2]({ grant, request, match: request.path.match(route[1])!, scope: (project, cap) => { authorize(grant, cap, { tenant: grant.tenant, project }); return { tenant: grant.tenant, project }; } });
        } catch (error) {
          if (error instanceof GrantError) response = json(403, { error: error.code, message: error.message });
          else if (error instanceof StoreError) response = json({ not_found: 404, conflict: 409, too_large: 413, invalid: 400, integrity: 500 }[error.code], { error: error.code, message: error.message });
          else response = json(500, { error: 'internal' });
        }
      }
      try { options.audit?.({ grant, method: request.method, path: request.path, status: response.status }); } catch { /* audit faults never change the response */ }
      return response;
    }
  };
}

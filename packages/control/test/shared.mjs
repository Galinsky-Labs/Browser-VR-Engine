// Contract tests run against every store implementation (memory and Postgres).
import assert from 'node:assert/strict';
import { createControlApi, issueGrant, StoreError } from '@browser-vr-engine/control';

export const SECRET = 'a'.repeat(32) + '-test-secret-only';
export const AUDIENCE = 'engine-control';
export const grant = (o = {}) => issueGrant({ secret: SECRET, subject: 'host-user-1', tenant: 'acme', project: 'demo', audience: AUDIENCE, ttlSeconds: 600, capabilities: ['workspace:create', 'workspace:read', 'document:read', 'document:write', 'object:read', 'object:write', 'job:submit', 'job:read'], ...o });

export function storeContract(test, makeStores) {
  test('documents: create-only, compare-and-swap, tenant isolation', async () => {
    const { documents } = await makeStores();
    const a = { tenant: 'acme', project: 'demo' };
    const b = { tenant: 'other', project: 'demo' };
    const first = await documents.put(a, 'world', 'lobby', { n: 1 }, 0);
    assert.equal(first.version, 1);
    await assert.rejects(documents.put(a, 'world', 'lobby', { n: 2 }, 0), e => e instanceof StoreError && e.code === 'conflict');
    const results = await Promise.allSettled([documents.put(a, 'world', 'lobby', { n: 'x' }, 1), documents.put(a, 'world', 'lobby', { n: 'y' }, 1)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1, 'concurrent CAS has one winner');
    assert.equal(await documents.get(b, 'world', 'lobby'), null, 'other tenant cannot read');
    assert.deepEqual((await documents.list(a, 'world')).map(d => d.id), ['lobby']);
    assert.deepEqual(await documents.list(b, 'world'), []);
    await assert.rejects(documents.put(a, 'world', '../x', {}, 0), e => e.code === 'invalid');
    await assert.rejects(documents.put(a, 'world', 'big', 'x'.repeat(1_100_000), 0), e => e.code === 'too_large');
    await assert.rejects(documents.remove(a, 'world', 'lobby', 1), e => e.code === 'conflict');
    await documents.remove(a, 'world', 'lobby', 2);
    assert.equal(await documents.get(a, 'world', 'lobby'), null);
  });

  test('objects: integrity hash, overwrite, isolation and removal', async () => {
    const { objects } = await makeStores();
    const a = { tenant: 'acme', project: 'demo' };
    const bytes = new TextEncoder().encode('hello world');
    const info = await objects.put(a, 'textures/a.txt', bytes, 'text/plain');
    assert.equal(info.sha256, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    assert.equal(info.size, 11);
    const got = await objects.get(a, 'textures/a.txt');
    assert.equal(new TextDecoder().decode(got.bytes), 'hello world');
    assert.equal(await objects.get({ tenant: 'acme', project: 'other' }, 'textures/a.txt'), null);
    assert.equal((await objects.put(a, 'textures/a.txt', new Uint8Array([1]), 'application/octet-stream')).size, 1);
    assert.equal((await objects.head(a, 'textures/a.txt')).size, 1);
    assert.equal(await objects.remove(a, 'textures/a.txt'), true);
    assert.equal(await objects.remove(a, 'textures/a.txt'), false);
    await assert.rejects(objects.put(a, '../escape', bytes, 'text/plain'), e => e.code === 'invalid');
  });

  test('jobs: idempotent submission, leases, retries and failure', async () => {
    const { jobs } = await makeStores();
    const s = { tenant: 'acme', project: 'demo' };
    const submissions = await Promise.all(Array.from({ length: 8 }, () => jobs.submit(s, 'convert', 'req-1', { file: 'a.glb' }, 2)));
    assert.equal(new Set(submissions.map(r => r.job.id)).size, 1, 'retries preserve one result');
    assert.equal(submissions.filter(r => r.created).length, 1);
    await assert.rejects(jobs.submit(s, 'convert', 'req-1', { file: 'b.glb' }), e => e.code === 'conflict');
    assert.equal(await jobs.claim({ tenant: 'other', project: 'demo' }, 'convert', 30), null, 'other tenants cannot claim');
    const claims = await Promise.all([jobs.claim(s, 'convert', 30), jobs.claim(s, 'convert', 30)]);
    assert.equal(claims.filter(Boolean).length, 1, 'one worker wins the lease');
    const job = claims.find(Boolean);
    const retried = await jobs.fail(s, job.id, 'transient');
    assert.equal(retried.state, 'queued');
    const again = await jobs.claim(s, 'convert', 30);
    assert.equal(again.attempts, 2);
    const failed = await jobs.fail(s, again.id, 'permanent');
    assert.equal(failed.state, 'failed');
    assert.equal(await jobs.claim(s, 'convert', 30), null);
    const ok = (await jobs.submit(s, 'convert', 'req-2', {})).job;
    const leased = await jobs.claim(s, 'convert', 30);
    assert.equal(leased.id, ok.id);
    const done = await jobs.complete(s, ok.id, { output: 'x' });
    assert.equal(done.state, 'succeeded');
    await assert.rejects(jobs.complete(s, ok.id, {}), e => e.code === 'conflict');
    assert.deepEqual((await jobs.submit(s, 'convert', 'req-2', {})).job.result, { output: 'x' });
  });

  test('a standalone host creates a scoped workspace and calls engine APIs without conference records', async () => {
    const stores = await makeStores();
    const audit = [];
    const api = createControlApi({ verify: { secrets: [SECRET], audience: AUDIENCE }, ...stores, audit: e => audit.push(e.status) });
    const auth = async o => ({ authorization: `Bearer ${await grant(o)}` });
    const call = async (method, path, extra = {}, o) => api.handle({ method, path, headers: { ...(await auth(o)), ...(extra.headers ?? {}) }, body: extra.body, bytes: extra.bytes });
    assert.equal((await call('POST', '/v1/workspaces', { body: { project: 'demo', name: 'Demo' } })).status, 201);
    assert.equal((await call('POST', '/v1/workspaces', { body: { project: 'demo' } })).status, 409);
    assert.equal((await call('GET', '/v1/workspaces/demo')).body.name, 'Demo');
    const put = await call('PUT', '/v1/projects/demo/documents/world/lobby', { body: { entities: [] }, headers: { 'if-match': '0' } });
    assert.equal(put.status, 201);
    assert.equal((await call('PUT', '/v1/projects/demo/documents/world/lobby', { body: {}, headers: { 'if-match': '0' } })).status, 409);
    assert.equal((await call('GET', '/v1/projects/demo/documents/world/lobby')).body.version, 1);
    const obj = await call('PUT', '/v1/projects/demo/objects/models/a.glb', { bytes: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'model/gltf-binary' } });
    assert.equal(obj.status, 201);
    const fetched = await call('GET', '/v1/projects/demo/objects/models/a.glb');
    assert.deepEqual([...fetched.bytes], [1, 2, 3]);
    assert.equal(fetched.headers['content-disposition'], 'attachment');
    const job1 = await call('POST', '/v1/projects/demo/jobs', { body: { type: 'convert', input: { key: 'models/a.glb' } }, headers: { 'idempotency-key': 'k1' } });
    const job2 = await call('POST', '/v1/projects/demo/jobs', { body: { type: 'convert', input: { key: 'models/a.glb' } }, headers: { 'idempotency-key': 'k1' } });
    assert.deepEqual([job1.status, job2.status], [202, 200]);
    assert.equal(job1.body.id, job2.body.id);
    assert.equal((await call('GET', `/v1/projects/demo/jobs/${job1.body.id}`)).body.state, 'queued');
    assert.equal((await call('POST', '/v1/projects/demo/jobs', { body: { type: 'convert' } })).status, 400);

    // Two tenants cannot access each other.
    const other = { tenant: 'rival', project: '*' };
    assert.equal((await call('GET', '/v1/projects/demo/documents/world/lobby', {}, other)).status, 404, 'rival sees no workspace of its own');
    assert.equal((await call('GET', '/v1/workspaces/demo', {}, other)).status, 404);
    // Project scoping and capabilities.
    assert.equal((await call('GET', '/v1/workspaces/demo', {}, { project: 'elsewhere' })).status, 403);
    assert.equal((await call('PUT', '/v1/projects/demo/documents/world/x', { body: {}, headers: { 'if-match': '0' } }, { capabilities: ['document:read'] })).status, 403);
    // Token expiry, audience and signature.
    assert.equal((await call('GET', '/v1/workspaces/demo', {}, { now: Date.now() - 3600_000, ttlSeconds: 60 })).status, 401);
    assert.equal((await api.handle({ method: 'GET', path: '/v1/workspaces/demo', headers: { authorization: `Bearer ${await grant({ audience: 'other' })}` } })).body.error, 'audience');
    const forged = (await grant()).replace(/.$/, c => c === 'A' ? 'B' : 'A');
    assert.equal((await api.handle({ method: 'GET', path: '/v1/workspaces/demo', headers: { authorization: `Bearer ${forged}` } })).body.error, 'bad_signature');
    assert.equal((await api.handle({ method: 'GET', path: '/v1/workspaces/demo', headers: {} })).status, 401);
    assert.ok(audit.includes(201) && audit.includes(403));
  });
}

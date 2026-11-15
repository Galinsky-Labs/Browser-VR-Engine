import test from 'node:test';
import assert from 'node:assert/strict';
import { issueGrant, verifyGrant, authorize, GrantError, createMemoryStores } from '@browser-vr-engine/control';
import { storeContract, SECRET, AUDIENCE, grant } from './shared.mjs';

storeContract(test, async () => createMemoryStores());

test('grants verify across secret rotation and reject tampering', async () => {
  const token = await grant();
  const g = await verifyGrant(token, { secrets: ['b'.repeat(40), SECRET], audience: AUDIENCE });
  assert.equal(g.tenant, 'acme');
  await assert.rejects(verifyGrant(token, { secrets: ['b'.repeat(40)], audience: AUDIENCE }), e => e.code === 'bad_signature');
  const [v, payload, sig] = token.split('.');
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), tenant: 'other' })).toString('base64url');
  await assert.rejects(verifyGrant(`${v}.${altered}.${sig}`, { secrets: [SECRET], audience: AUDIENCE }), e => e.code === 'bad_signature');
  await assert.rejects(verifyGrant('v2.x.y', { secrets: [SECRET], audience: AUDIENCE }), e => e.code === 'malformed');
  await assert.rejects(verifyGrant(token, { secrets: [SECRET], audience: AUDIENCE, now: Date.now() + 700_000 }), e => e.code === 'expired');
  await assert.rejects(verifyGrant(await grant({ now: Date.now() + 120_000 }), { secrets: [SECRET], audience: AUDIENCE }), e => e.code === 'not_yet_valid');
});

test('issuance rejects weak secrets, unknown capabilities, bad namespaces and long lifetimes', async () => {
  await assert.rejects(issueGrant({ secret: 'short', subject: 's', tenant: 'a', project: 'b', capabilities: ['world:join'], audience: 'x', ttlSeconds: 60 }), /32 characters/);
  await assert.rejects(grant({ capabilities: ['root'] }), /Unknown capability/);
  await assert.rejects(grant({ tenant: 'Bad Tenant' }), /namespace/);
  await assert.rejects(grant({ ttlSeconds: 90_000 }), /lifetime/);
});

test('authorization is tenant- and project-scoped', async () => {
  const g = await verifyGrant(await grant({ project: '*', capabilities: ['document:read'] }), { secrets: [SECRET], audience: AUDIENCE });
  authorize(g, 'document:read', { tenant: 'acme', project: 'any' });
  assert.throws(() => authorize(g, 'document:read', { tenant: 'rival', project: 'any' }), GrantError);
  assert.throws(() => authorize(g, 'document:write', { tenant: 'acme', project: 'any' }), e => e.code === 'forbidden');
});

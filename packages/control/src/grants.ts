/**
 * Host-injected identity (F08). The host application authenticates people and
 * issues short-lived, HMAC-signed engine grants. The engine never sees product
 * roles: only tenant/project namespaces and engine capabilities.
 */

export const CAPABILITIES = [
  'workspace:create', 'workspace:read',
  'document:read', 'document:write',
  'object:read', 'object:write',
  'job:submit', 'job:read', 'job:work',
  'world:join', 'world:edit', 'media:publish', 'media:subscribe', 'moderate'
] as const;
export type Capability = typeof CAPABILITIES[number];

export interface Grant {
  v: 1;
  /** Subject chosen by the host (opaque to the engine). */
  sub: string;
  tenant: string;
  /** A project id or '*' for every project in the tenant. */
  project: string;
  caps: Capability[];
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export class GrantError extends Error {
  readonly code: 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid' | 'audience' | 'forbidden' | 'scope';
  constructor(code: GrantError['code'], message: string) { super(message); this.name = 'GrantError'; this.code = code; }
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const isNamespace = (value: unknown): value is string => typeof value === 'string' && NAME.test(value);

const encoder = new TextEncoder();
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new GrantError('malformed', 'Grant is not base64url');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Grant secrets must be at least 32 characters');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface IssueOptions {
  secret: string;
  subject: string;
  tenant: string;
  project: string;
  capabilities: readonly Capability[];
  audience: string;
  ttlSeconds: number;
  now?: number;
}

export async function issueGrant(options: IssueOptions): Promise<string> {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (!isNamespace(options.tenant) || !(options.project === '*' || isNamespace(options.project))) throw new Error('Invalid tenant or project namespace');
  if (!options.capabilities.length || options.capabilities.some(cap => !CAPABILITIES.includes(cap))) throw new Error('Unknown capability');
  if (!(options.ttlSeconds > 0 && options.ttlSeconds <= 86_400)) throw new Error('Grant lifetime must be 1 s to 24 h');
  if (typeof options.subject !== 'string' || !options.subject || options.subject.length > 200) throw new Error('Invalid subject');
  const jti = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const grant: Grant = { v: 1, sub: options.subject, tenant: options.tenant, project: options.project, caps: [...new Set(options.capabilities)].sort() as Capability[], aud: options.audience, iat: now, exp: now + Math.floor(options.ttlSeconds), jti };
  const payload = b64url(encoder.encode(JSON.stringify(grant)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await key(options.secret), encoder.encode(`v1.${payload}`)));
  return `v1.${payload}.${b64url(signature)}`;
}

export interface VerifyOptions {
  /** Current secret first; previous secrets accepted during rotation. */
  secrets: readonly string[];
  audience: string;
  now?: number;
  clockSkewSeconds?: number;
}

export async function verifyGrant(token: unknown, options: VerifyOptions): Promise<Grant> {
  if (typeof token !== 'string' || token.length > 4096) throw new GrantError('malformed', 'Missing or oversized grant');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new GrantError('malformed', 'Unsupported grant format');
  const signature = fromB64url(parts[2]!);
  let valid = false;
  for (const secret of options.secrets) {
    if (await crypto.subtle.verify('HMAC', await key(secret), signature as BufferSource, encoder.encode(`v1.${parts[1]}`))) { valid = true; break; }
  }
  if (!valid) throw new GrantError('bad_signature', 'Grant signature is invalid');
  let grant: Grant;
  try { grant = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as Grant; } catch { throw new GrantError('malformed', 'Grant payload is not JSON'); }
  if (grant.v !== 1 || !isNamespace(grant.tenant) || !(grant.project === '*' || isNamespace(grant.project)) || !Array.isArray(grant.caps) || grant.caps.some(cap => !CAPABILITIES.includes(cap))) throw new GrantError('malformed', 'Grant claims are invalid');
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds ?? 30;
  if (grant.aud !== options.audience) throw new GrantError('audience', 'Grant was issued for another audience');
  if (!(grant.exp > now - skew)) throw new GrantError('expired', 'Grant has expired');
  if (grant.iat > now + skew) throw new GrantError('not_yet_valid', 'Grant is not valid yet');
  return grant;
}

/** Tenants are isolated: a grant only ever reaches its own tenant, and its own project unless it holds '*'. */
export function authorize(grant: Grant, capability: Capability, scope: { tenant: string; project: string }): void {
  if (grant.tenant !== scope.tenant || (grant.project !== '*' && grant.project !== scope.project)) throw new GrantError('scope', 'Grant does not cover this tenant or project');
  if (!grant.caps.includes(capability)) throw new GrantError('forbidden', `Grant lacks ${capability}`);
}

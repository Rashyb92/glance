import { createHmac, timingSafeEqual } from 'node:crypto';
import { isTeamRole, type TeamRole } from '@glance/core';

/**
 * Tenant resolution from a client token.
 *
 * - **Dev** (no `GLANCE_AUTH_SECRET`): the token is taken as the tenant key, or
 *   `'default'` — so local `pnpm dev` works with no auth.
 * - **Production** (`GLANCE_AUTH_SECRET` set): the token must be a valid, unexpired
 *   HMAC-signed `<tenant>.<exp>.<sig>` (mint with {@link signToken}). `exp` is a unix
 *   second; `0` means non-expiring.
 */
export function resolveTenant(token: string | undefined): string | null {
  const secret = process.env['GLANCE_AUTH_SECRET'];
  if (!secret) return (token && token.trim()) || 'default';
  // Owner-scoped: accept a session token or a legacy tenant token, but not a member login.
  const session = verifySessionToken(token, secret);
  if (session) return session.tenant;
  return verifyToken(token, secret);
}

export interface TokenOptions {
  /** Lifetime in seconds. Omit (or <= 0) for a non-expiring token. */
  ttlSeconds?: number;
}

/** Issue a signed tenant token `<tenant>.<exp>.<sig>`. */
export function signToken(tenant: string, secret: string, opts: TokenOptions = {}): string {
  const exp =
    opts.ttlSeconds && opts.ttlSeconds > 0
      ? Math.floor(Date.now() / 1000) + Math.floor(opts.ttlSeconds)
      : 0;
  const body = `${tenant}.${exp}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Issue a signed, revocable owner session token `<tenant>.<sessionId>.<iat>.<exp>.<sig>`. */
export function signSessionToken(
  tenant: string,
  sessionId: string,
  secret: string,
  opts: TokenOptions = {},
): string {
  const iat = Math.floor(Date.now() / 1000);
  const exp = opts.ttlSeconds && opts.ttlSeconds > 0 ? iat + Math.floor(opts.ttlSeconds) : 0;
  const body = `${tenant}.${sessionId}.${iat}.${exp}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [tenant, expRaw, sig] = parts;
  if (!tenant || expRaw === undefined || !sig) return null;

  const expected = createHmac('sha256', secret).update(`${tenant}.${expRaw}`).digest('base64url');
  if (!safeEqual(sig, expected)) return null;

  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp)) return null;
  if (exp !== 0 && exp < Math.floor(Date.now() / 1000)) return null; // expired

  return tenant;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * An authenticated caller: always a tenant, plus a team role and member id when the
 * token is a per-member login. Legacy tenant tokens (and dev mode) resolve as `owner`.
 */
export interface Actor {
  tenant: string;
  role: TeamRole;
  memberId?: string;
  /** Present for owner *session* tokens (revocable via the session store). */
  sessionId?: string;
  /** Token issued-at (unix seconds) — checked against the tenant's revoke-all epoch. */
  issuedAt?: number;
}

/** Issue a signed per-member login token `<tenant>.<memberId>.<role>.<exp>.<sig>`. */
export function signMemberToken(
  tenant: string,
  memberId: string,
  role: TeamRole,
  secret: string,
  opts: TokenOptions = {},
): string {
  const exp =
    opts.ttlSeconds && opts.ttlSeconds > 0
      ? Math.floor(Date.now() / 1000) + Math.floor(opts.ttlSeconds)
      : 0;
  const body = `${tenant}.${memberId}.${role}.${exp}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Resolve a client token to an {@link Actor}. Dev (no secret): the token is the tenant
 * key (or `default`), as owner. Production: accepts either a per-member token or a
 * legacy tenant token (which resolves as owner).
 */
export function resolveActor(token: string | undefined): Actor | null {
  const secret = process.env['GLANCE_AUTH_SECRET'];
  if (!secret) {
    const tenant = (token && token.trim()) || 'default';
    return { tenant, role: 'owner' };
  }
  const member = verifyMemberToken(token, secret);
  if (member) return member;
  const session = verifySessionToken(token, secret);
  if (session) return session;
  const tenant = verifyToken(token, secret);
  return tenant ? { tenant, role: 'owner' } : null;
}

function verifyMemberToken(token: string | undefined, secret: string): Actor | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [tenant, memberId, role, expRaw, sig] = parts;
  if (!tenant || !memberId || !role || expRaw === undefined || !sig) return null;
  if (!isTeamRole(role)) return null;
  const expected = createHmac('sha256', secret)
    .update(`${tenant}.${memberId}.${role}.${expRaw}`)
    .digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp)) return null;
  if (exp !== 0 && exp < Math.floor(Date.now() / 1000)) return null; // expired
  return { tenant, memberId, role };
}

/** Verify an owner session token `<tenant>.<sessionId>.<iat>.<exp>.<sig>`. Revocation (logout /
 *  revoke-all) is enforced separately against the session store, using `sessionId` + `issuedAt`. */
function verifySessionToken(token: string | undefined, secret: string): Actor | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [tenant, sessionId, iatRaw, expRaw, sig] = parts;
  if (!tenant || !sessionId || iatRaw === undefined || expRaw === undefined || !sig) return null;
  const iat = Number.parseInt(iatRaw, 10);
  const exp = Number.parseInt(expRaw, 10);
  // Both numeric distinguishes a session token from a member token (whose 3rd segment is a role).
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
  const expected = createHmac('sha256', secret)
    .update(`${tenant}.${sessionId}.${iatRaw}.${expRaw}`)
    .digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  if (exp !== 0 && exp < Math.floor(Date.now() / 1000)) return null; // expired
  return { tenant, role: 'owner', sessionId, issuedAt: iat };
}

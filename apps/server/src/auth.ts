import { createHmac, timingSafeEqual } from 'node:crypto';

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

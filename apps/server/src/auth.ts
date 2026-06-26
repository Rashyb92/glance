import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tenant resolution from a client token.
 *
 * - **Dev** (no `GLANCE_AUTH_SECRET`): the token is taken as the tenant key, or
 *   `'default'` — so local `pnpm dev` works with no auth.
 * - **Production** (`GLANCE_AUTH_SECRET` set): the token must be a valid HMAC-signed
 *   `<tenant>.<sig>`. The token-issuance flow (login → signed token, expiry) is the
 *   security milestone; this is the verification half.
 */
export function resolveTenant(token: string | undefined): string | null {
  const secret = process.env['GLANCE_AUTH_SECRET'];
  if (!secret) return (token && token.trim()) || 'default';
  return verifyToken(token, secret);
}

/** Issue a signed tenant token `<tenant>.<sig>`. */
export function signToken(tenant: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(tenant).digest('base64url');
  return `${tenant}.${sig}`;
}

function verifyToken(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const tenant = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(tenant).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return tenant;
  } catch {
    /* malformed token */
  }
  return null;
}

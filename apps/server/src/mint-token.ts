/**
 * Mint a signed tenant token for the gateway. Requires GLANCE_AUTH_SECRET.
 *
 *   GLANCE_AUTH_SECRET=… node dist/mint-token.js <tenant> [ttlDays]
 *
 * Prints the token to stdout. Omit ttlDays for a non-expiring token. Clients pass
 * it as `?token=…` (WebSocket) or `Authorization: Bearer …` (REST).
 */
import { signToken } from './auth';

const secret = process.env['GLANCE_AUTH_SECRET'];
const tenant = process.argv[2];
const ttlDays = Number.parseInt(process.argv[3] ?? '', 10);

if (!secret) {
  console.error('error: GLANCE_AUTH_SECRET is not set');
  process.exit(1);
} else if (!tenant) {
  console.error('usage: mint-token <tenant> [ttlDays]');
  process.exit(1);
} else {
  const opts = Number.isFinite(ttlDays) && ttlDays > 0 ? { ttlSeconds: ttlDays * 86_400 } : {};
  console.log(signToken(tenant, secret, opts));
}

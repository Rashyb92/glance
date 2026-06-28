import { timingSafeEqual } from 'node:crypto';

/**
 * Operator (Glance staff) authentication for the admin/support console — a separate trust domain
 * from tenant/account auth. Configure with either:
 *   - `GLANCE_ADMIN_TOKENS` = `alice:tokenA,bob:tokenB` — per-operator tokens, so the audit log
 *     attributes each action to a named operator; and/or
 *   - `GLANCE_ADMIN_TOKEN`  = a single shared token (recorded as operator "admin").
 *
 * With neither set the admin API is disabled and every operator lookup fails closed (no token can
 * resolve), so the console is inert until an operator credential is deliberately provisioned.
 */
export class AdminAuth {
  private readonly tokens: Array<{ name: string; token: string }> = [];

  constructor(env: { tokens?: string; token?: string } = {}) {
    const pairs = env.tokens ?? process.env['GLANCE_ADMIN_TOKENS'];
    if (pairs) {
      for (const part of pairs.split(',')) {
        const idx = part.indexOf(':');
        if (idx <= 0) continue; // need a non-empty name before the colon
        const name = part.slice(0, idx).trim();
        const token = part.slice(idx + 1).trim();
        if (name && token) this.tokens.push({ name, token });
      }
    }
    const single = (env.token ?? process.env['GLANCE_ADMIN_TOKEN'])?.trim();
    if (single) this.tokens.push({ name: 'admin', token: single });
  }

  /** Whether any operator credential is configured (the admin API is live). */
  get enabled(): boolean {
    return this.tokens.length > 0;
  }

  /**
   * Resolve the operator name for a request's `Authorization: Bearer <token>` header, or null when
   * the token is missing/unknown. Compares against every configured token (no early return) so the
   * response time doesn't reveal which operator matched.
   */
  resolveOperator(authHeader: string | undefined): string | null {
    const presented = this.bearer(authHeader);
    if (!presented) return null;
    let matched: string | null = null;
    for (const entry of this.tokens) {
      if (this.safeEqual(presented, entry.token)) matched = entry.name;
    }
    return matched;
  }

  private bearer(header: string | undefined): string | null {
    if (!header || !header.startsWith('Bearer ')) return null;
    const t = header.slice(7).trim();
    return t || null;
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false; // timingSafeEqual requires equal lengths
    return timingSafeEqual(ab, bb);
  }
}

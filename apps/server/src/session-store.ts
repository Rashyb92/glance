import type { KvStore } from './kv';
import { KvCache } from './kv-cache';

/** Matches the session-token TTL (7 days): past this a revoked session id is harmless. */
const REVOKE_TTL_MS = 7 * 86_400_000;

interface Persisted {
  /** Explicitly logged-out session ids → expiry epoch ms. */
  revoked: Array<{ id: string; exp: number }>;
  /** "Revoke all": tokens issued (iat, unix seconds) before this are rejected. */
  epoch: number;
}

/**
 * Owner-session revocation — the kill switch the stateless signed tokens lacked.
 *
 * A session token carries a per-login session id and an issued-at (iat). It is valid iff its id
 * isn't on the logout list AND it was issued at/after the tenant's epoch. `revoke` logs out one
 * session; `revokeAll` bumps the epoch so every existing token is rejected (stolen-token kill
 * switch / "sign out everywhere"). Checks are synchronous (in-memory, sync-cached); state is
 * persisted to Postgres and re-hydrated on tenant load so revocations survive restarts/migration.
 */
export class SessionStore {
  private readonly revoked = new Map<string, Map<string, number>>(); // tenant -> (sessionId -> exp)
  private readonly epoch = new Map<string, number>(); // tenant -> min issued-at (unix seconds)
  private readonly cache?: KvCache;

  constructor(
    kv?: KvStore,
    private readonly publish?: (msg: string) => void,
  ) {
    if (kv) this.cache = new KvCache(kv);
  }

  /** Log out a single session. */
  revoke(tenant: string, sessionId: string, now = Date.now()): void {
    const m = this.revoked.get(tenant) ?? new Map<string, number>();
    m.set(sessionId, now + REVOKE_TTL_MS);
    this.revoked.set(tenant, m);
    this.persist(tenant);
    this.publish?.(JSON.stringify({ scope: 'session', tenant, id: sessionId }));
  }

  /** Revoke every session for a tenant (sign out everywhere / stolen-token kill switch). */
  revokeAll(tenant: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
    this.epoch.set(tenant, nowSeconds);
    this.persist(tenant);
    this.publish?.(JSON.stringify({ scope: 'session-all', tenant, ts: nowSeconds }));
  }

  /** Apply a revocation received from another instance (no re-broadcast, no re-persist). */
  applyRemote(msg: { scope?: string; tenant?: string; id?: string; ts?: number }): void {
    if (!msg.tenant) return;
    if (msg.scope === 'session-all') {
      this.epoch.set(msg.tenant, msg.ts ?? Math.floor(Date.now() / 1000));
    } else if (msg.scope === 'session' && msg.id) {
      const m = this.revoked.get(msg.tenant) ?? new Map<string, number>();
      m.set(msg.id, Date.now() + REVOKE_TTL_MS);
      this.revoked.set(msg.tenant, m);
    }
  }

  /** A session token is active iff not logged out and issued at/after the tenant epoch. */
  isActive(tenant: string, sessionId: string, issuedAt: number, now = Date.now()): boolean {
    const exp = this.revoked.get(tenant)?.get(sessionId);
    if (exp !== undefined) {
      if (exp > now) return false; // explicitly logged out
      this.revoked.get(tenant)?.delete(sessionId); // expired entry — clean up
    }
    if (issuedAt < (this.epoch.get(tenant) ?? 0)) return false; // revoked-all after issue
    return true;
  }

  /** Warm a tenant's revocation state from the durable store (call on tenant load). */
  async hydrate(tenant: string, now = Date.now()): Promise<void> {
    if (!this.cache) return;
    await this.cache.hydrate(this.key(tenant));
    const raw = this.cache.read(this.key(tenant));
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as Persisted;
      const m = this.revoked.get(tenant) ?? new Map<string, number>();
      for (const entry of data.revoked ?? []) if (entry.exp > now) m.set(entry.id, entry.exp);
      this.revoked.set(tenant, m);
      if (typeof data.epoch === 'number') {
        this.epoch.set(tenant, Math.max(this.epoch.get(tenant) ?? 0, data.epoch));
      }
    } catch {
      /* corrupt record — ignore */
    }
  }

  private persist(tenant: string): void {
    if (!this.cache) return;
    const revoked = [...(this.revoked.get(tenant) ?? new Map<string, number>())].map(([id, exp]) => ({
      id,
      exp,
    }));
    const data: Persisted = { revoked, epoch: this.epoch.get(tenant) ?? 0 };
    this.cache.write(this.key(tenant), JSON.stringify(data));
  }

  private key(tenant: string): string {
    return `session:${tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'}`;
  }
}

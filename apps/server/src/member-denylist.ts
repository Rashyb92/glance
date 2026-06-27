import type { KvStore } from './kv';
import { KvCache } from './kv-cache';

interface RevokedEntry {
  id: string;
  /** Epoch ms after which the revocation can be forgotten (the token has expired by then). */
  exp: number;
}

/** Matches the member-token TTL (30 days): past this, a revoked id is harmless — the token is dead. */
const REVOCATION_TTL_MS = 30 * 86_400_000;

/**
 * Denylist of revoked members for instant token rejection. Removing a member — or an explicit
 * force-logout — adds them here, so their signed token is rejected on the next request/connection
 * without waiting for the 30-day TTL.
 *
 * When a {@link KvStore} is supplied, revocations are persisted (one key per tenant) and
 * re-hydrated on tenant load, so a force-logout survives an instance restart or tenant migration
 * under tenant-sticky routing. Entries self-expire at the token TTL so the list can't grow forever.
 * (For non-sticky deployments where one tenant's members span instances, additionally broadcast
 * revokes over the Bus — noted in the deploy runbook.)
 */
export class MemberDenylist {
  /** tenant -> (memberId -> expiry epoch ms). The synchronous source of truth for isRevoked. */
  private readonly mem = new Map<string, Map<string, number>>();
  private readonly cache?: KvCache;

  constructor(kv?: KvStore) {
    if (kv) this.cache = new KvCache(kv);
  }

  revoke(tenant: string, memberId: string, now = Date.now()): void {
    const members = this.mem.get(tenant) ?? new Map<string, number>();
    members.set(memberId, now + REVOCATION_TTL_MS);
    this.mem.set(tenant, members);
    this.persist(tenant);
  }

  restore(tenant: string, memberId: string): void {
    if (this.mem.get(tenant)?.delete(memberId)) this.persist(tenant);
  }

  isRevoked(tenant: string, memberId: string, now = Date.now()): boolean {
    const exp = this.mem.get(tenant)?.get(memberId);
    if (exp === undefined) return false;
    if (exp <= now) {
      this.mem.get(tenant)?.delete(memberId); // expired — the token is gone anyway
      return false;
    }
    return true;
  }

  /** Warm a tenant's revocations from the durable store (call on tenant load). No-op for memory-only. */
  async hydrate(tenant: string, now = Date.now()): Promise<void> {
    if (!this.cache) return;
    await this.cache.hydrate(this.key(tenant));
    const stored = this.cache.read(this.key(tenant));
    if (!stored) return;
    try {
      const list = JSON.parse(stored) as RevokedEntry[];
      const members = this.mem.get(tenant) ?? new Map<string, number>();
      for (const entry of list) if (entry.exp > now) members.set(entry.id, entry.exp);
      this.mem.set(tenant, members);
    } catch {
      /* corrupt record — ignore */
    }
  }

  private persist(tenant: string): void {
    if (!this.cache) return;
    const members = this.mem.get(tenant);
    const list: RevokedEntry[] = members ? [...members].map(([id, exp]) => ({ id, exp })) : [];
    this.cache.write(this.key(tenant), JSON.stringify(list));
  }

  private key(tenant: string): string {
    return `deny:${tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'}`;
  }
}

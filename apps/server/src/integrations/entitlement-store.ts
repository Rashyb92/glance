import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PLAN, type PlanId } from '@glance/core';
import { KvCache, readFileOrNull } from '../kv-cache';
import type { KvStore } from '../kv';

interface Entitlement {
  plan: PlanId;
  stripeCustomerId?: string;
  updatedAt: number;
}

/**
 * Per-tenant plan record. The Stripe webhook writes it (webhook-first provisioning);
 * the Hub reads it to gate each tenant's settings via {@link applyPlanLimits}.
 */
export class EntitlementStore {
  private readonly cache?: KvCache;

  constructor(
    private readonly dir: string,
    kv?: KvStore,
  ) {
    mkdirSync(dir, { recursive: true });
    if (kv) this.cache = new KvCache(kv);
  }

  getPlan(tenant: string): PlanId {
    return this.read(tenant)?.plan ?? DEFAULT_PLAN;
  }

  /** Eagerly warm a tenant's plan from the durable store (cold-start correctness). No-op for files. */
  async hydrate(tenant: string): Promise<void> {
    if (this.cache) await this.cache.hydrate(`ent:${this.safe(tenant)}`);
  }

  /** Delete a tenant's plan record (account deletion). */
  eraseTenant(tenant: string): void {
    if (this.cache) this.cache.remove(`ent:${this.safe(tenant)}`);
    else {
      try {
        rmSync(this.fileFor(tenant));
      } catch {
        /* already gone */
      }
    }
  }

  customerId(tenant: string): string | undefined {
    return this.read(tenant)?.stripeCustomerId;
  }

  setPlan(tenant: string, plan: PlanId, stripeCustomerId?: string): void {
    const current = this.read(tenant);
    const next: Entitlement = { plan, updatedAt: Date.now() };
    const customer = stripeCustomerId ?? current?.stripeCustomerId;
    if (customer) next.stripeCustomerId = customer;

    if (this.cache) {
      this.cache.write(`ent:${this.safe(tenant)}`, JSON.stringify(next));
      return;
    }
    const file = this.fileFor(tenant);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), 'utf8');
    renameSync(tmp, file);
  }

  private read(tenant: string): Entitlement | null {
    const raw = this.cache
      ? this.cache.read(`ent:${this.safe(tenant)}`)
      : readFileOrNull(this.fileFor(tenant));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Entitlement;
    } catch {
      return null;
    }
  }

  private safe(tenant: string): string {
    return tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  }

  private fileFor(tenant: string): string {
    const safe = tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    return join(this.dir, `${safe}.json`);
  }
}

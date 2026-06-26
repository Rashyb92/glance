import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PLAN, type PlanId } from '@glance/core';

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
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  getPlan(tenant: string): PlanId {
    return this.read(tenant)?.plan ?? DEFAULT_PLAN;
  }

  customerId(tenant: string): string | undefined {
    return this.read(tenant)?.stripeCustomerId;
  }

  setPlan(tenant: string, plan: PlanId, stripeCustomerId?: string): void {
    const current = this.read(tenant);
    const next: Entitlement = { plan, updatedAt: Date.now() };
    const customer = stripeCustomerId ?? current?.stripeCustomerId;
    if (customer) next.stripeCustomerId = customer;

    const file = this.fileFor(tenant);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), 'utf8');
    renameSync(tmp, file);
  }

  private read(tenant: string): Entitlement | null {
    try {
      return JSON.parse(readFileSync(this.fileFor(tenant), 'utf8')) as Entitlement;
    } catch {
      return null;
    }
  }

  private fileFor(tenant: string): string {
    const safe = tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    return join(this.dir, `${safe}.json`);
  }
}

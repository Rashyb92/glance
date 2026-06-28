import type { KvStore } from '../kv';
import { logger } from '../logger';
import { metrics } from '../metrics';

/**
 * Privacy-respecting product analytics — a content-free activation funnel.
 *
 * We record only that a tenant (a pseudonymous UUID) reached a milestone: signed up, activated
 * (first session), engaged (first surfaced moment), subscribed (first paid plan). No message text,
 * no chatter identities, no email — just `{tenant, stage}`. Each stage is counted once per tenant.
 *
 * The authoritative funnel is derived on demand from the durable per-tenant records (distinct-tenant
 * accurate and restart-safe), so there is no aggregate counter to race or lose. Per-stage event
 * volume also increments a Prometheus counter for ops dashboards. Disable entirely with
 * GLANCE_ANALYTICS_DISABLED=1.
 */
export type FunnelStage = 'signup' | 'activated' | 'engaged' | 'subscribed';
export const FUNNEL_STAGES: readonly FunnelStage[] = [
  'signup',
  'activated',
  'engaged',
  'subscribed',
] as const;

export interface FunnelReport {
  funnel: Record<FunnelStage, number>;
  /** Stage-to-stage conversion, 0..100 (rounded): activation=activated/signup, etc. */
  conversion: { activation: number; engagement: number; subscription: number };
}

const isStage = (s: unknown): s is FunnelStage =>
  typeof s === 'string' && (FUNNEL_STAGES as readonly string[]).includes(s);

export class ProductAnalytics {
  /** tenant -> stages reached this process. The sync source of truth that short-circuits the
   *  hot path (a stage already in the set never touches the durable store again). */
  private readonly reached = new Map<string, Set<FunnelStage>>();

  constructor(
    private readonly kv?: KvStore,
    private readonly enabled = true,
  ) {}

  /** Record that a tenant reached a funnel stage. Deduped per tenant; only the first counts. */
  reach(tenant: string, stage: FunnelStage): void {
    if (!this.enabled || !tenant || tenant === 'default') return; // skip the local/demo tenant
    const set = this.reached.get(tenant);
    if (set?.has(stage)) return; // already recorded this process — O(1) short-circuit
    const next = set ?? new Set<FunnelStage>();
    next.add(stage);
    this.reached.set(tenant, next);
    metrics.inc(`glance_funnel_${stage}_total`);
    logger.info('funnel', { tenant, stage }); // content-free: tenant UUID + stage
    void this.persist(tenant);
  }

  /** Distinct-tenant funnel, derived from the durable records (or in-memory when no KvStore). */
  async report(): Promise<FunnelReport> {
    const funnel: Record<FunnelStage, number> = { signup: 0, activated: 0, engaged: 0, subscribed: 0 };
    if (this.kv) {
      for (const { value } of await this.kv.list('analytics:reach:')) {
        for (const stage of this.parse(value)) funnel[stage] += 1;
      }
    } else {
      for (const set of this.reached.values()) for (const stage of set) funnel[stage] += 1;
    }
    const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 100) : 0);
    return {
      funnel,
      conversion: {
        activation: pct(funnel.activated, funnel.signup),
        engagement: pct(funnel.engaged, funnel.activated),
        subscription: pct(funnel.subscribed, funnel.engaged),
      },
    };
  }

  /** Warm a tenant's reached stages from the durable store (call on tenant load) so a stage isn't
   *  re-emitted to metrics after a restart / migration. Merges — never clobbers. */
  async hydrate(tenant: string): Promise<void> {
    if (!this.kv) return;
    const durable = await this.readStages(tenant);
    if (durable.length === 0) return;
    const set = this.reached.get(tenant) ?? new Set<FunnelStage>();
    for (const s of durable) set.add(s);
    this.reached.set(tenant, set);
  }

  /** Read-merge-write so a persist can never drop a stage recorded before this process hydrated. */
  private async persist(tenant: string): Promise<void> {
    if (!this.kv) return;
    try {
      const set = this.reached.get(tenant) ?? new Set<FunnelStage>();
      for (const s of await this.readStages(tenant)) set.add(s);
      this.reached.set(tenant, set);
      await this.kv.put(this.key(tenant), JSON.stringify([...set]));
    } catch {
      /* best-effort — analytics must never break the request path */
    }
  }

  private async readStages(tenant: string): Promise<FunnelStage[]> {
    if (!this.kv) return [];
    const raw = await this.kv.get(this.key(tenant));
    return raw ? this.parse(raw) : [];
  }

  private parse(raw: string): FunnelStage[] {
    try {
      const arr: unknown = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(isStage) : [];
    } catch {
      return [];
    }
  }

  private key(tenant: string): string {
    return `analytics:reach:${tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'}`;
  }
}

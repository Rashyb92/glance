import { createHmac, timingSafeEqual } from 'node:crypto';
import { isPlanId, type PlanId } from '@glance/core';
import type { KvStore } from '../kv';

/**
 * Verify a Stripe webhook signature (`Stripe-Signature` header). Stripe signs
 * `${timestamp}.${rawBody}` with HMAC-SHA256 under the endpoint secret; we compare
 * in constant time and reject stale timestamps (replay protection). Skipping this
 * is the classic way a SaaS leaks paid access — so it is mandatory.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader || !secret) return false;
  const fields = new Map<string, string>();
  for (const kv of signatureHeader.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) fields.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const t = fields.get('t');
  const v1 = fields.get('v1');
  if (!t || !v1) return false;

  const ts = Number.parseInt(t, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  try {
    const a = Buffer.from(v1);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface StripeEventLite {
  /** Stripe event id (`evt_…`) — used for idempotent processing. */
  id?: string;
  type: string;
  /** Event creation time (unix seconds) — used to drop out-of-order deliveries. */
  created?: number;
  data: { object: Record<string, unknown> };
}

/**
 * Idempotency + ordering for Stripe webhooks. A duplicate delivery (Stripe retries aggressively)
 * is dropped by event id; an out-of-order delivery is dropped by comparing the event's `created`
 * time against the last change applied for that tenant — so a late "subscription.updated" can't
 * resurrect a plan a later "subscription.deleted" already cancelled. KV-backed so the guarantee
 * holds across instances; in-memory fallback for dev / single-instance.
 */
export class StripeEventLedger {
  private readonly seen = new Set<string>();
  private readonly lastApplied = new Map<string, number>();

  constructor(private readonly kv?: KvStore) {}

  /** True if this event should be applied (not a duplicate, not stale). Records it either way. */
  async shouldApply(
    eventId: string | undefined,
    tenant: string,
    createdSec: number,
  ): Promise<boolean> {
    if (!eventId) return true; // nothing to dedupe on — apply best-effort
    if (await this.isSeen(eventId)) return false; // duplicate delivery
    await this.markSeen(eventId);
    if (createdSec > 0) {
      if (createdSec < (await this.getLast(tenant))) return false; // out-of-order
      await this.setLast(tenant, createdSec);
    }
    return true;
  }

  private safe(tenant: string): string {
    return tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  }
  private async isSeen(id: string): Promise<boolean> {
    if (this.kv) return (await this.kv.get(`stripeevt:${id}`)) !== null;
    return this.seen.has(id);
  }
  private async markSeen(id: string): Promise<void> {
    if (this.kv) await this.kv.put(`stripeevt:${id}`, '1');
    else this.seen.add(id);
  }
  private async getLast(tenant: string): Promise<number> {
    if (this.kv) {
      const raw = await this.kv.get(`stripelast:${this.safe(tenant)}`);
      return raw ? Number(raw) || 0 : 0;
    }
    return this.lastApplied.get(tenant) ?? 0;
  }
  private async setLast(tenant: string, sec: number): Promise<void> {
    if (this.kv) await this.kv.put(`stripelast:${this.safe(tenant)}`, String(sec));
    else this.lastApplied.set(tenant, sec);
  }
}

/**
 * Map a billing event to the tenant + plan it implies. Provisioning is webhook-first
 * (the research-recommended pattern): the tenant's plan is only granted/revoked when
 * Stripe confirms it, never optimistically from the client.
 */
export function planChangeFromEvent(
  event: StripeEventLite,
): { tenant: string; plan: PlanId; customerId?: string } | null {
  const obj = event.data.object;
  const tenant = readTenant(obj);
  if (!tenant) return null;
  const customerId = typeof obj['customer'] === 'string' ? obj['customer'] : undefined;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'invoice.paid': {
      const plan = readPlan(obj);
      return plan ? { tenant, plan, customerId } : null;
    }
    case 'customer.subscription.deleted':
      return { tenant, plan: 'free', customerId };
    default:
      return null;
  }
}

function readTenant(obj: Record<string, unknown>): string | null {
  const meta = obj['metadata'];
  if (meta && typeof meta === 'object') {
    const t = (meta as Record<string, unknown>)['tenant'];
    if (typeof t === 'string' && t) return t;
  }
  const ref = obj['client_reference_id'];
  return typeof ref === 'string' && ref ? ref : null;
}

function readPlan(obj: Record<string, unknown>): PlanId | null {
  const meta = obj['metadata'];
  if (meta && typeof meta === 'object') {
    const p = (meta as Record<string, unknown>)['plan'];
    if (typeof p === 'string' && isPlanId(p)) return p;
  }
  return null;
}

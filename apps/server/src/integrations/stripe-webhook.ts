import { createHmac, timingSafeEqual } from 'node:crypto';
import { isPlanId, type PlanId } from '@glance/core';

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
  type: string;
  data: { object: Record<string, unknown> };
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

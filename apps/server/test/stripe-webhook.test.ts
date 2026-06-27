import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { planChangeFromEvent, verifyStripeSignature } from '../src/integrations/stripe-webhook';

function sign(body: string, secret: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1' });
  const now = 1_000_000;

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifyStripeSignature(body, sign(body, secret, now), secret, 300, now)).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifyStripeSignature(`${body}x`, sign(body, secret, now), secret, 300, now)).toBe(false);
  });
  it('rejects a wrong secret', () => {
    expect(verifyStripeSignature(body, sign(body, 'other', now), secret, 300, now)).toBe(false);
  });
  it('rejects a stale timestamp (replay protection)', () => {
    expect(verifyStripeSignature(body, sign(body, secret, now - 10_000), secret, 300, now)).toBe(
      false,
    );
  });
  it('rejects a missing header', () => {
    expect(verifyStripeSignature(body, undefined, secret, 300, now)).toBe(false);
  });
});

describe('planChangeFromEvent', () => {
  it('grants the plan from metadata on invoice.paid', () => {
    const e = {
      type: 'invoice.paid',
      data: { object: { metadata: { tenant: 'acme', plan: 'pro' } } },
    };
    expect(planChangeFromEvent(e)).toEqual({ tenant: 'acme', plan: 'pro' });
  });
  it('captures the stripe customer id for the billing portal', () => {
    const e = {
      type: 'checkout.session.completed',
      data: { object: { metadata: { tenant: 'acme', plan: 'pro' }, customer: 'cus_123' } },
    };
    expect(planChangeFromEvent(e)).toEqual({ tenant: 'acme', plan: 'pro', customerId: 'cus_123' });
  });

  it('downgrades to free on subscription deletion', () => {
    const e = {
      type: 'customer.subscription.deleted',
      data: { object: { client_reference_id: 'acme' } },
    };
    expect(planChangeFromEvent(e)).toEqual({ tenant: 'acme', plan: 'free' });
  });
  it('ignores unrelated events and events without a tenant', () => {
    expect(
      planChangeFromEvent({ type: 'payment_intent.created', data: { object: { metadata: {} } } }),
    ).toBeNull();
    expect(
      planChangeFromEvent({ type: 'invoice.paid', data: { object: { metadata: { plan: 'pro' } } } }),
    ).toBeNull();
  });
});

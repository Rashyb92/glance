import type { PlanId } from '@glance/core';

/**
 * Stripe billing over the REST API — no SDK dependency (global `fetch`). Creates
 * subscription Checkout Sessions and Customer Portal links. The API version is
 * pinned (a 2026 SaaS best practice) so Stripe-side changes can't silently break us.
 *
 * Requires STRIPE_SECRET_KEY and a price id per paid plan
 * (STRIPE_PRICE_CREATOR, STRIPE_PRICE_PRO).
 */
const STRIPE_API_VERSION = '2024-06-20';

export class BillingService {
  constructor(
    private readonly secretKey: string | undefined,
    private readonly successUrl: string,
    private readonly cancelUrl: string,
  ) {}

  configured(): boolean {
    return Boolean(this.secretKey);
  }

  /** Start a subscription. Returns the hosted Checkout URL to redirect the creator to. */
  async createCheckoutSession(tenant: string, plan: PlanId): Promise<string> {
    if (!this.secretKey) throw new Error('billing not configured');
    const price = priceFor(plan);
    if (!price) throw new Error(`no Stripe price configured for plan: ${plan}`);
    const body = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      success_url: this.successUrl,
      cancel_url: this.cancelUrl,
      client_reference_id: tenant,
      'metadata[tenant]': tenant,
      'metadata[plan]': plan,
      'subscription_data[metadata][tenant]': tenant,
      'subscription_data[metadata][plan]': plan,
    });
    return this.urlFrom('https://api.stripe.com/v1/checkout/sessions', body);
  }

  /** Open the Customer Portal so a creator can manage/cancel their subscription. */
  async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
    if (!this.secretKey) throw new Error('billing not configured');
    const body = new URLSearchParams({ customer: customerId, return_url: returnUrl });
    return this.urlFrom('https://api.stripe.com/v1/billing_portal/sessions', body);
  }

  private async urlFrom(endpoint: string, body: URLSearchParams): Promise<string> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secretKey ?? ''}`,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': STRIPE_API_VERSION,
      },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`stripe responded ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const url = json['url'];
    if (typeof url !== 'string') throw new Error('stripe returned no url');
    return url;
  }
}

function priceFor(plan: PlanId): string | undefined {
  if (plan === 'creator') return process.env['STRIPE_PRICE_CREATOR'];
  if (plan === 'pro') return process.env['STRIPE_PRICE_PRO'];
  return undefined;
}

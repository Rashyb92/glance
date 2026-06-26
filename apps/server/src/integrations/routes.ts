import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isPlanId } from '@glance/core';
import { resolveTenant } from '../auth';
import { logger } from '../logger';
import { isProviderId } from './oauth-providers';
import type { OAuthService } from './oauth-service';
import type { TokenStore } from './oauth-token-store';
import type { BillingService } from './billing';
import type { EntitlementStore } from './entitlement-store';
import { planChangeFromEvent, verifyStripeSignature, type StripeEventLite } from './stripe-webhook';

const MAX_BODY = 1024 * 1024; // 1 MB cap on integration bodies

export interface IntegrationDeps {
  oauth: OAuthService;
  tokens: TokenStore;
  billing: BillingService;
  entitlements: EntitlementStore;
  webhookSecret: string | undefined;
  dashboardUrl: string;
}

/**
 * Short-lived OAuth `state` store (CSRF + tenant/verifier binding). In-memory; for a
 * multi-instance deployment, back it with Redis (same shape).
 */
export class OAuthStateStore {
  private readonly map = new Map<string, { tenant: string; verifier?: string; exp: number }>();

  constructor(private readonly ttlMs = 600_000) {}

  put(state: string, tenant: string, verifier: string | undefined, now: number = Date.now()): void {
    this.map.set(state, { tenant, verifier, exp: now + this.ttlMs });
  }

  take(state: string, now: number = Date.now()): { tenant: string; verifier?: string } | null {
    const entry = this.map.get(state);
    if (!entry) return null;
    this.map.delete(state); // one-time use
    if (entry.exp < now) return null;
    return { tenant: entry.tenant, verifier: entry.verifier };
  }
}

const states = new OAuthStateStore();

/**
 * Handles `/api/oauth/*`, `/api/billing/*`, and `/api/stripe/webhook`. Returns true if it
 * handled the path. The OAuth callback and the Stripe webhook are intentionally reachable
 * without a tenant token (resolved by `state` / signature); the rest are tenant-scoped.
 * Every route fails soft with a clear error until the matching keys are configured.
 */
export function handleIntegrationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  cors: Record<string, string>,
  deps: IntegrationDeps,
): boolean {
  if (
    !path.startsWith('/api/oauth/') &&
    !path.startsWith('/api/billing/') &&
    path !== '/api/stripe/webhook'
  ) {
    return false;
  }

  const send = (code: number, body?: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', ...cors });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const redirect = (location: string): void => {
    res.writeHead(302, { location, ...cors });
    res.end();
  };

  // OAuth: start the link (tenant-scoped).
  if (path.startsWith('/api/oauth/') && path.endsWith('/start')) {
    const provider = path.slice('/api/oauth/'.length, -'/start'.length);
    if (!isProviderId(provider)) {
      send(404, { error: 'unknown provider' });
      return true;
    }
    const tenant = resolveTenant(tokenFromReq(req));
    if (!tenant) {
      send(401, { error: 'unauthorized' });
      return true;
    }
    if (!deps.oauth.available(provider)) {
      send(501, { error: `${provider} oauth not configured` });
      return true;
    }
    const state = randomBytes(16).toString('base64url');
    const built = deps.oauth.buildAuthorize(provider, state);
    states.put(state, tenant, built.verifier);
    redirect(built.url);
    return true;
  }

  // OAuth: provider redirects back here with code + state (no tenant token).
  if (path.startsWith('/api/oauth/') && path.endsWith('/callback')) {
    const provider = path.slice('/api/oauth/'.length, -'/callback'.length);
    if (!isProviderId(provider)) {
      send(404, { error: 'unknown provider' });
      return true;
    }
    const code = queryParam(req.url, 'code');
    const state = queryParam(req.url, 'state');
    const entry = state ? states.take(state) : null;
    if (!code || !entry) {
      send(400, { error: 'invalid oauth callback' });
      return true;
    }
    deps.oauth
      .exchangeCode(provider, code, entry.verifier)
      .then((tokens) => {
        deps.tokens.save(entry.tenant, provider, tokens);
        logger.info('oauth linked', { tenant: entry.tenant, provider });
        redirect(`${deps.dashboardUrl}?linked=${provider}`);
      })
      .catch((err: Error) => {
        logger.warn('oauth exchange failed', { provider, error: err.message });
        redirect(`${deps.dashboardUrl}?error=oauth`);
      });
    return true;
  }

  // Billing: start a subscription checkout (tenant-scoped).
  if (path === '/api/billing/checkout' && req.method === 'POST') {
    const tenant = resolveTenant(tokenFromReq(req));
    if (!tenant) {
      send(401, { error: 'unauthorized' });
      return true;
    }
    if (!deps.billing.configured()) {
      send(501, { error: 'billing not configured' });
      return true;
    }
    readJson(req)
      .then((body) => {
        const plan = typeof body['plan'] === 'string' && isPlanId(body['plan']) ? body['plan'] : null;
        if (!plan || plan === 'free') {
          send(400, { error: 'invalid plan' });
          return undefined;
        }
        return deps.billing.createCheckoutSession(tenant, plan).then((url) => send(200, { url }));
      })
      .catch((err: Error) => send(400, { error: err.message }));
    return true;
  }

  // Billing: open the customer portal (tenant-scoped).
  if (path === '/api/billing/portal' && req.method === 'POST') {
    const tenant = resolveTenant(tokenFromReq(req));
    if (!tenant) {
      send(401, { error: 'unauthorized' });
      return true;
    }
    const customerId = deps.entitlements.customerId(tenant);
    if (!deps.billing.configured() || !customerId) {
      send(400, { error: 'no active subscription' });
      return true;
    }
    deps.billing
      .createPortalSession(customerId, deps.dashboardUrl)
      .then((url) => send(200, { url }))
      .catch((err: Error) => send(400, { error: err.message }));
    return true;
  }

  // Stripe webhook (signature-verified raw body, no token).
  if (path === '/api/stripe/webhook' && req.method === 'POST') {
    const secret = deps.webhookSecret;
    if (!secret) {
      send(501, { error: 'webhook not configured' });
      return true;
    }
    readRaw(req)
      .then((raw) => {
        const sig = req.headers['stripe-signature'];
        if (!verifyStripeSignature(raw, typeof sig === 'string' ? sig : undefined, secret)) {
          send(400, { error: 'invalid signature' });
          return;
        }
        let event: StripeEventLite;
        try {
          event = JSON.parse(raw) as StripeEventLite;
        } catch {
          send(400, { error: 'bad json' });
          return;
        }
        const change = planChangeFromEvent(event);
        if (change) {
          deps.entitlements.setPlan(change.tenant, change.plan);
          logger.info('plan updated via stripe', change);
        }
        send(200, { received: true });
      })
      .catch(() => send(400, { error: 'read error' }));
    return true;
  }

  send(404, { error: 'not found' });
  return true;
}

// --- small local helpers (kept here so the module is self-contained) ---

function tokenFromReq(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return queryParam(req.url, 'token');
}

function queryParam(url: string | undefined, name: string): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  return new URLSearchParams(url.slice(q + 1)).get(name) ?? undefined;
}

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        req.destroy();
        reject(new Error('too_large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', () => reject(new Error('request_error')));
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new Error('invalid_json');
  }
}

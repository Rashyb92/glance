import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { isPlanId } from '@glance/core';
import { resolveActor, resolveTenant } from '../auth';
import { logger } from '../logger';
import { isProviderId } from './oauth-providers';
import type { OAuthService } from './oauth-service';
import type { TokenStore } from './oauth-token-store';
import type { BillingService } from './billing';
import type { EntitlementStore } from './entitlement-store';
import {
  planChangeFromEvent,
  verifyStripeSignature,
  StripeEventLedger,
  type StripeEventLite,
} from './stripe-webhook';
import type { KvStore } from '../kv';
import type { AuthService } from '../accounts';
import type { PairingStore } from '../pairing-store';

const MAX_BODY = 1024 * 1024; // 1 MB cap on integration bodies

export interface IntegrationDeps {
  oauth: OAuthService;
  tokens: TokenStore;
  billing: BillingService;
  entitlements: EntitlementStore;
  webhookSecret: string | undefined;
  dashboardUrl: string;
  /** Self-serve account auth (signup / login / refresh). */
  auth: AuthService;
  /** Short-lived OAuth `state` store — Postgres-backed for multi-instance callbacks. */
  oauthState: OAuthStateStore;
  /** Single-use device-pairing codes (so a pairing link carries a code, not the owner token). */
  pairing: PairingStore;
  /** Stripe webhook idempotency + ordering ledger. */
  stripeLedger: StripeEventLedger;
}

/**
 * Short-lived OAuth `state` store (CSRF + tenant/verifier binding). In-memory; for a
 * multi-instance deployment, back it with Redis (same shape).
 */
export class OAuthStateStore {
  private readonly map = new Map<string, { tenant: string; verifier?: string; exp: number }>();

  constructor(
    private readonly ttlMs = 600_000,
    private readonly kv?: KvStore,
  ) {}

  async put(
    state: string,
    tenant: string,
    verifier: string | undefined,
    now: number = Date.now(),
  ): Promise<void> {
    const entry = { tenant, verifier, exp: now + this.ttlMs };
    if (this.kv) {
      await this.kv.put(this.key(state), JSON.stringify(entry));
      return;
    }
    this.map.set(state, entry);
  }

  async take(
    state: string,
    now: number = Date.now(),
  ): Promise<{ tenant: string; verifier?: string } | null> {
    if (this.kv) {
      const raw = await this.kv.get(this.key(state));
      if (!raw) return null;
      await this.kv.delete(this.key(state)); // one-time use
      try {
        const entry = JSON.parse(raw) as { tenant: string; verifier?: string; exp: number };
        return entry.exp < now ? null : { tenant: entry.tenant, verifier: entry.verifier };
      } catch {
        return null;
      }
    }
    const entry = this.map.get(state);
    if (!entry) return null;
    this.map.delete(state); // one-time use
    if (entry.exp < now) return null;
    return { tenant: entry.tenant, verifier: entry.verifier };
  }

  private key(state: string): string {
    return `oauthstate:${state}`;
  }
}

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
    !path.startsWith('/api/auth/') &&
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

  // Auth: self-serve signup / login / token rotation. These mint a runtime session token —
  // no token is ever baked into a client build.
  if (path === '/api/auth/signup' || path === '/api/auth/login') {
    if (req.method !== 'POST') {
      send(405, { error: 'method not allowed' });
      return true;
    }
    const isSignup = path.endsWith('/signup');
    readJson(req)
      .then(async (body) => {
        const email = typeof body['email'] === 'string' ? body['email'] : '';
        const password = typeof body['password'] === 'string' ? body['password'] : '';
        const result = isSignup
          ? await deps.auth.signup(email, password)
          : await deps.auth.login(email, password);
        send('error' in result ? (isSignup ? 400 : 401) : 200, result);
      })
      .catch(() => send(400, { error: 'invalid request' }));
    return true;
  }
  if (path === '/api/auth/refresh' && req.method === 'POST') {
    const tenant = resolveTenant(tokenFromReq(req));
    if (!tenant) {
      send(401, { error: 'unauthorized' });
      return true;
    }
    send(200, deps.auth.refresh(tenant));
    return true;
  }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    const actor = resolveActor(tokenFromReq(req));
    if (!actor) {
      send(401, { error: 'unauthorized' });
      return true;
    }
    if (actor.sessionId) deps.auth.logout(actor.tenant, actor.sessionId);
    send(200, { ok: true });
    return true;
  }
  if (path === '/api/auth/revoke-all' && req.method === 'POST') {
    const actor = resolveActor(tokenFromReq(req));
    if (!actor) {
      send(401, { error: 'unauthorized' });
      return true;
    }
    deps.auth.revokeAll(actor.tenant);
    send(200, { ok: true });
    return true;
  }
  // A short-lived WS connect ticket — so the long-lived token stays in this POST's header,
  // and only a 30s token ever appears in the WebSocket URL.
  if (path === '/api/auth/ws-ticket' && req.method === 'POST') {
    const actor = resolveActor(tokenFromReq(req));
    if (!actor) {
      send(401, { error: 'unauthorized' });
      return true;
    }
    send(200, deps.auth.issueTicket(actor));
    return true;
  }
  // Issue a single-use device-pairing code (owner-scoped). The pairing link carries this code,
  // not the owner token.
  if (path === '/api/auth/pair' && req.method === 'POST') {
    const tenant = resolveTenant(tokenFromReq(req));
    if (!tenant) {
      send(401, { error: 'unauthorized' });
      return true;
    }
    void deps.pairing
      .issue(tenant)
      .then((code) => send(200, { code }))
      .catch(() => send(500, { error: 'pairing unavailable' }));
    return true;
  }
  // Unauthenticated: the one-time code *is* the credential. Exchange it for a device session token.
  if (path === '/api/auth/pair/exchange' && req.method === 'POST') {
    readJson(req)
      .then(async (body) => {
        const code = typeof body['code'] === 'string' ? body['code'] : '';
        const tenant = await deps.pairing.consume(code);
        if (!tenant) {
          send(401, { error: 'invalid or expired pairing code' });
          return;
        }
        send(200, deps.auth.refresh(tenant));
      })
      .catch(() => send(400, { error: 'invalid request' }));
    return true;
  }

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
    void deps.oauthState
      .put(state, tenant, built.verifier)
      .then(() => redirect(built.url))
      .catch(() => redirect(built.url));
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
    if (!code || !state) {
      send(400, { error: 'invalid oauth callback' });
      return true;
    }
    void deps.oauthState
      .take(state)
      .then(async (entry) => {
        if (!entry) {
          send(400, { error: 'invalid oauth callback' });
          return;
        }
        const tokens = await deps.oauth.exchangeCode(provider, code, entry.verifier);
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
      .then(async (raw) => {
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
          // Idempotent + order-safe: drop duplicate / out-of-order deliveries before mutating plans.
          if (await deps.stripeLedger.shouldApply(event.id, change.tenant, event.created ?? 0)) {
            deps.entitlements.setPlan(change.tenant, change.plan, change.customerId);
            logger.info('plan updated via stripe', { tenant: change.tenant, plan: change.plan });
          } else {
            logger.info('stripe event skipped (duplicate or out-of-order)', {
              event: event.id,
              tenant: change.tenant,
            });
          }
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

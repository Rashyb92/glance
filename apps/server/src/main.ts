import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAIProvider } from '@glance/ai';
import { loadConfig } from './config';
import { startGateway } from './gateway';
import { Hub } from './hub';
import { InProcessBus } from './bus';
import { FileSettingsStore, KvSettingsStore } from './settings-store';
import { FileStorage } from './storage';
import { PgKvStore, type KvStore } from './kv';
import { createPgClient } from './pg-client';
import { OAuthService } from './integrations/oauth-service';
import { TokenStore } from './integrations/oauth-token-store';
import type { ProviderId } from './integrations/oauth-providers';
import { BillingService } from './integrations/billing';
import { EntitlementStore } from './integrations/entitlement-store';
import type { IntegrationDeps } from './integrations/routes';
import { TeamStore } from './team-store';
import { PushStore } from './push-store';
import { DefaultPushProvider, Notifier } from './push';
import { WebPushProvider } from './web-push';
import { logger } from './logger';

// Refuse to boot in production without auth: with no secret every client collapses
// onto the `default` tenant, which would expose tenants to each other.
// Fail closed: require a signing secret in any non-local environment (production, staging,
// preview). Without it every client collapses onto the `default` tenant, exposing tenants.
const nodeEnv = process.env['NODE_ENV'];
const isLocalEnv = nodeEnv === undefined || nodeEnv === 'development' || nodeEnv === 'test';
if (!isLocalEnv && !process.env['GLANCE_AUTH_SECRET']) {
  logger.error('GLANCE_AUTH_SECRET is required when NODE_ENV is set (non-dev) — refusing to start');
  process.exit(1);
}

const config = loadConfig();
const ai = createAIProvider(config.ai);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Keep a tenant id safe to use as a directory / file name segment. */
function safeTenant(tenant: string): string {
  return tenant.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
}

const tokens = new TokenStore(resolve(repoRoot, '.data', 'tokens'));
const oauth = new OAuthService(
  process.env['GLANCE_PUBLIC_URL'] ?? `http://localhost:${config.wsPort}`,
);

const dashboardUrl = process.env['GLANCE_DASHBOARD_URL'] ?? 'http://localhost:5174';
const entitlements = new EntitlementStore(resolve(repoRoot, '.data', 'entitlements'));
const billing = new BillingService(
  process.env['STRIPE_SECRET_KEY'],
  `${dashboardUrl}?billing=success`,
  `${dashboardUrl}?billing=cancel`,
);
// OAuth + billing routes mounted on the gateway. Each fails soft until its keys exist.
const integrations: IntegrationDeps = {
  oauth,
  tokens,
  billing,
  entitlements,
  webhookSecret: process.env['STRIPE_WEBHOOK_SECRET'],
  dashboardUrl,
};

/** Reads (and refreshes near expiry) a tenant's stored token for a provider. */
function tokenAccessor(provider: ProviderId) {
  return {
    hasToken: (tenant: string): boolean => tokens.load(tenant, provider) !== null,
    getToken: async (tenant: string): Promise<string | null> => {
      const tok = tokens.load(tenant, provider);
      if (!tok) return null;
      if (tok.expiresAt > Date.now() + 60_000) return tok.accessToken;
      if (!tok.refreshToken) return tok.accessToken;
      try {
        const next = await oauth.refresh(provider, tok.refreshToken);
        tokens.save(tenant, provider, next);
        return next.accessToken;
      } catch {
        return tok.accessToken; // use the stale token; the adapter surfaces failures
      }
    },
  };
}

const bus = new InProcessBus();
const team = new TeamStore(resolve(repoRoot, '.data', 'teams'));
const push = new PushStore(resolve(repoRoot, '.data', 'push'));

// Push the highest-signal moments (priority callouts, channel events) to each tenant's
// registered devices — the wearables / phone-companion render target.
// Real background delivery when VAPID keys are configured (Web Push to the companion /
// wearables); otherwise webhook subs still POST and apns/fcm log via the default provider.
const defaultPush = new DefaultPushProvider((m) => logger.info(m));
const vapidPublic = process.env['VAPID_PUBLIC_KEY'];
const vapidPrivate = process.env['VAPID_PRIVATE_KEY'];
const pushProvider =
  vapidPublic && vapidPrivate
    ? new WebPushProvider(
        vapidPublic,
        vapidPrivate,
        process.env['VAPID_SUBJECT'] ?? 'mailto:ops@glance.app',
        defaultPush,
      )
    : defaultPush;
const notifier = new Notifier(push, pushProvider);
bus.subscribe((tenant, message) => notifier.consider(tenant, message));

// Live readers activate when the matching app is configured; otherwise tenants fall
// back to IRC (Twitch) or the demo feed.
const twitchClientId = process.env['TWITCH_CLIENT_ID'];
const twitchLink = twitchClientId
  ? { clientId: twitchClientId, ...tokenAccessor('twitch') }
  : undefined;
const youtubeLink = process.env['YOUTUBE_CLIENT_ID'] ? tokenAccessor('youtube') : undefined;

// Durable settings store: Postgres (shared across instances) when DATABASE_URL is set,
// otherwise the file store. `pg` is an optional dependency, loaded only on this path.
const databaseUrl = process.env['DATABASE_URL'];
let settingsKv: KvStore | null = null;
if (databaseUrl) {
  try {
    settingsKv = new PgKvStore(createPgClient(databaseUrl));
    logger.info('settings store: Postgres (multi-instance)');
  } catch (err) {
    logger.warn('DATABASE_URL is set but pg is unavailable — using file settings', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const hub = new Hub({
  ai,
  bus,
  makeStorage: (tenant) => new FileStorage(resolve(repoRoot, '.data', 'sessions', safeTenant(tenant))),
  makeSettingsStore: (tenant) =>
    settingsKv
      ? new KvSettingsStore(settingsKv, `settings:${safeTenant(tenant)}`)
      : new FileSettingsStore(resolve(repoRoot, '.data', 'settings', `${safeTenant(tenant)}.json`)),
  twitchLink,
  youtubeLink,
  team,
  push,
  // Enforce real plans only when billing is configured; dev/self-host stays ungated.
  entitlements: process.env['STRIPE_SECRET_KEY'] ? entitlements : undefined,
});

const gateway = startGateway(config.wsPort, hub, bus, integrations);

// Auto-connect the default tenant so a local `pnpm dev` lights up immediately.
hub.connect('default', config.channel, config.demo);

// Enforce each tenant's data-retention policy on a slow cadence.
const retentionTimer = setInterval(() => hub.runRetention(), 3_600_000);
retentionTimer.unref?.();

// Reclaim idle push-notifier state so its per-tenant maps can't grow without bound.
const notifierSweep = setInterval(() => notifier.sweep(), 3_600_000);
notifierSweep.unref?.();

logger.info('Glance server is live', {
  aiProvider: ai.name,
  wsGateway: `ws://localhost:${config.wsPort}`,
  metrics: `http://localhost:${config.wsPort}/metrics`,
  hud: 'http://localhost:5173',
  dashboard: 'http://localhost:5174',
  auth: process.env['GLANCE_AUTH_SECRET'] ? 'token (multi-tenant)' : 'dev (default tenant)',
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down…');
  await hub.shutdown(); // archives every tenant's live session and drains writes
  gateway.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

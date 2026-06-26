import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAIProvider } from '@glance/ai';
import { loadConfig } from './config';
import { startGateway } from './gateway';
import { Hub } from './hub';
import { InProcessBus } from './bus';
import { FileSettingsStore } from './settings-store';
import { FileStorage } from './storage';
import { OAuthService } from './integrations/oauth-service';
import { TokenStore } from './integrations/oauth-token-store';
import { TeamStore } from './team-store';
import { logger } from './logger';

// Refuse to boot in production without auth: with no secret every client collapses
// onto the `default` tenant, which would expose tenants to each other.
if (process.env['NODE_ENV'] === 'production' && !process.env['GLANCE_AUTH_SECRET']) {
  logger.error('GLANCE_AUTH_SECRET is required in production — refusing to start');
  process.exit(1);
}

const config = loadConfig();
const ai = createAIProvider(config.ai);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Keep a tenant id safe to use as a directory / file name segment. */
function safeTenant(tenant: string): string {
  return tenant.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
}

/** Live-Twitch link: reads a tenant's stored token (refreshing if near expiry). */
function buildTwitchLink(clientId: string) {
  const tokens = new TokenStore(resolve(repoRoot, '.data', 'tokens'));
  const oauth = new OAuthService(
    process.env['GLANCE_PUBLIC_URL'] ?? `http://localhost:${config.wsPort}`,
  );
  return {
    clientId,
    hasToken: (tenant: string): boolean => tokens.load(tenant, 'twitch') !== null,
    getToken: async (tenant: string): Promise<string | null> => {
      const tok = tokens.load(tenant, 'twitch');
      if (!tok) return null;
      if (tok.expiresAt > Date.now() + 60_000) return tok.accessToken;
      if (!tok.refreshToken) return tok.accessToken;
      try {
        const next = await oauth.refresh('twitch', tok.refreshToken);
        tokens.save(tenant, 'twitch', next);
        return next.accessToken;
      } catch {
        return tok.accessToken; // use the stale token; the adapter surfaces failures
      }
    },
  };
}

const bus = new InProcessBus();
const team = new TeamStore(resolve(repoRoot, '.data', 'teams'));
// Active only when a Twitch app is configured; otherwise tenants use the IRC reader.
const twitchClientId = process.env['TWITCH_CLIENT_ID'];
const twitchLink = twitchClientId ? buildTwitchLink(twitchClientId) : undefined;

const hub = new Hub({
  ai,
  bus,
  makeStorage: (tenant) => new FileStorage(resolve(repoRoot, '.data', 'sessions', safeTenant(tenant))),
  makeSettingsStore: (tenant) =>
    new FileSettingsStore(resolve(repoRoot, '.data', 'settings', `${safeTenant(tenant)}.json`)),
  twitchLink,
  team,
});

const gateway = startGateway(config.wsPort, hub, bus);

// Auto-connect the default tenant so a local `pnpm dev` lights up immediately.
hub.connect('default', config.channel, config.demo);

// Enforce each tenant's data-retention policy on a slow cadence.
const retentionTimer = setInterval(() => hub.runRetention(), 3_600_000);
retentionTimer.unref?.();

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

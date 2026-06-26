import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAIProvider } from '@glance/ai';
import { loadConfig } from './config';
import { startGateway } from './gateway';
import { Hub } from './hub';
import { InProcessBus } from './bus';
import { FileSettingsStore } from './settings-store';
import { FileStorage } from './storage';
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

const bus = new InProcessBus();
const hub = new Hub({
  ai,
  bus,
  makeStorage: (tenant) => new FileStorage(resolve(repoRoot, '.data', 'sessions', safeTenant(tenant))),
  makeSettingsStore: (tenant) =>
    new FileSettingsStore(resolve(repoRoot, '.data', 'settings', `${safeTenant(tenant)}.json`)),
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

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAIProvider } from '@glance/ai';
import { loadConfig } from './config';
import { startGateway } from './gateway';
import { SessionController } from './session';
import { FileSettingsStore, SettingsService } from './settings-store';
import { FileStorage } from './storage';
import { logger } from './logger';

const log = (message: string): void => logger.info(message);

const config = loadConfig();
const ai = createAIProvider(config.ai);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const settingsStore = new FileSettingsStore(resolve(repoRoot, '.data', 'settings.json'));
const storage = new FileStorage(resolve(repoRoot, '.data', 'sessions'));

const controller = new SessionController({ ai, storage, log });

const settings = new SettingsService(settingsStore, (next) => {
  controller.applySettings(next);
  gateway.broadcast({ type: 'settings', data: next });
});

const gateway = startGateway(config.wsPort, {
  getSnapshot: () => controller.snapshot(40),
  getSession: () => controller.getState(),
  connect: (channel, demo) => controller.connect(channel, demo),
  disconnect: () => controller.disconnect(),
  getSettings: () => settings.get(),
  updateSettings: (patch) => settings.update(patch),
  listSessions: () => storage.listSessions(),
  getReplay: (id) => storage.getSession(id),
  deleteReplay: (id) => storage.deleteSession(id),
});

controller.setBroadcast(gateway.broadcast);
controller.applySettings(settings.get());
controller.connect(config.channel, config.demo);

logger.info('Glance server is live', {
  aiProvider: ai.name,
  wsGateway: `ws://localhost:${config.wsPort}`,
  metrics: `http://localhost:${config.wsPort}/metrics`,
  hud: 'http://localhost:5173',
  dashboard: 'http://localhost:5174',
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down…');
  controller.shutdown(); // triggers a final archive of the live session
  await controller.drain(5000); // wait for archive writes to flush before exit
  gateway.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAIProvider } from '@glance/ai';
import { loadConfig } from './config';
import { startGateway } from './gateway';
import { SessionController } from './session';
import { FileSettingsStore, SettingsService } from './settings-store';
import { FileStorage } from './storage';

function log(message: string): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`\x1b[2m${t}\x1b[0m ${message}`);
}

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

log('—');
log('Glance server is live');
log(`  ai provider : ${ai.name}${ai.name === 'rules' ? ' (add ANTHROPIC_API_KEY for Claude)' : ''}`);
log(`  control api : http://localhost:${config.wsPort}/api/session · /api/settings · /api/sessions`);
log(`  ws gateway  : ws://localhost:${config.wsPort}  (health: /health)`);
log('  HUD         : http://localhost:5173');
log('  Dashboard   : http://localhost:5174   (connect + tune here)');
log('—');

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

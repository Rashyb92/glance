import { createAIProvider } from '@glance/ai';
import { StatsAggregator } from '@glance/core';
import { DemoAdapter, TwitchAdapter } from '@glance/platforms';
import type { AdapterHandlers, PlatformAdapter } from '@glance/platforms';
import { loadConfig } from './config';
import { GlanceEngine } from './engine';
import { startGateway } from './gateway';

function log(message: string): void {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`\x1b[2m${t}\x1b[0m ${message}`);
}

const config = loadConfig();
const ai = createAIProvider(config.ai);
const stats = new StatsAggregator(config.channel || 'demo');

const engine = new GlanceEngine({
  channel: config.channel || 'demo',
  broadcaster: config.broadcaster,
  ai,
  summaryIntervalMs: config.summaryIntervalMs,
  onItem: (item) => {
    if (item.type === 'message') stats.ingestMessage(item.data);
    else if (item.type === 'event') stats.ingestEvent(item.data);
    gateway.broadcast(item);
  },
});

const gateway = startGateway(config.wsPort, () => engine.snapshot(40));
engine.start();

const statsTimer = setInterval(() => {
  gateway.broadcast({ type: 'stats', data: stats.snapshot() });
}, 2000);

const adapters: PlatformAdapter[] = [];
if (config.channel) adapters.push(new TwitchAdapter(config.channel));
if (config.demo || adapters.length === 0) {
  adapters.push(new DemoAdapter(config.channel || 'glance_demo'));
}

for (const adapter of adapters) {
  const handlers: AdapterHandlers = {
    onMessage: (m) => engine.ingestMessage(m),
    onEvent: (e) => engine.ingestEvent(e),
    onStatus: (s) => {
      const extra = 'reason' in s && s.reason ? ` (${s.reason})` : '';
      log(`[${adapter.platform}:${adapter.channel}] ${s.state}${extra}`);
    },
  };
  adapter.start(handlers);
}

log('—');
log('Glance server is live');
log(`  channel    : ${config.channel || '(demo only)'}`);
log(`  demo feed  : ${config.demo ? 'on' : 'off'}`);
log(`  ai provider: ${ai.name}${ai.name === 'rules' ? ' (add ANTHROPIC_API_KEY for Claude)' : ''}`);
log(`  ws gateway : ws://localhost:${config.wsPort}  (health: http://localhost:${config.wsPort}/health)`);
log('  HUD        : http://localhost:5173');
log('  Dashboard  : http://localhost:5174');
log('—');

function shutdown(): void {
  log('shutting down…');
  clearInterval(statsTimer);
  for (const adapter of adapters) void adapter.stop();
  engine.stop();
  gateway.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

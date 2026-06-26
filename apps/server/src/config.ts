import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Load a .env file from the repo root or the current working directory, if present. */
function loadEnv(): void {
  const loader = (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile;
  if (typeof loader !== 'function') return;
  const here = dirname(fileURLToPath(import.meta.url)); // apps/server/src
  const candidates = [resolve(here, '../../../.env'), resolve(process.cwd(), '.env')];
  for (const path of candidates) {
    try {
      loader(path);
      return;
    } catch {
      /* try the next candidate */
    }
  }
}
loadEnv();

export interface ServerConfig {
  channel: string;
  demo: boolean;
  wsPort: number;
  broadcaster?: string;
  summaryIntervalMs: number;
  ai: { anthropicApiKey?: string; model?: string };
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
}

export function loadConfig(): ServerConfig {
  const channel = (process.env['GLANCE_CHANNEL'] ?? '').trim().replace(/^#/, '');
  const demo = (process.env['GLANCE_DEMO'] ?? 'true').toLowerCase() !== 'false';
  return {
    channel,
    demo,
    wsPort: int(process.env['GLANCE_WS_PORT'], 8787),
    broadcaster: channel || undefined,
    summaryIntervalMs: int(process.env['GLANCE_SUMMARY_MS'], 15000),
    ai: {
      anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
      model: process.env['GLANCE_AI_MODEL'],
    },
  };
}

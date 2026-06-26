import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { logger } from './logger';

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

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Build and validate the server config from the environment. Fails fast on values
 * that can't be safely defaulted (e.g. an out-of-range port); soft issues are
 * corrected with a warning so a typo never silently breaks the deployment.
 */
export function loadConfig(): ServerConfig {
  let channel = (process.env['GLANCE_CHANNEL'] ?? '').trim().replace(/^#/, '').toLowerCase();
  if (channel && !/^[a-z0-9_]{3,25}$/.test(channel)) {
    logger.warn('GLANCE_CHANNEL is not a valid channel login — ignoring', {
      value: channel.slice(0, 40),
    });
    channel = '';
  }

  const wsPort = int(process.env['GLANCE_WS_PORT'], 8787);
  if (!Number.isInteger(wsPort) || wsPort < 1 || wsPort > 65535) {
    throw new Error(`invalid GLANCE_WS_PORT: ${process.env['GLANCE_WS_PORT'] ?? '(unset)'}`);
  }

  const summaryIntervalMs = clampInt(int(process.env['GLANCE_SUMMARY_MS'], 15000), 4000, 120000);

  if (!process.env['ANTHROPIC_API_KEY']) {
    logger.info('ANTHROPIC_API_KEY not set — using the deterministic rules AI provider');
  }

  return {
    channel,
    demo: (process.env['GLANCE_DEMO'] ?? 'true').toLowerCase() !== 'false',
    wsPort,
    broadcaster: channel || undefined,
    summaryIntervalMs,
    ai: {
      anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
      model: process.env['GLANCE_AI_MODEL'],
    },
  };
}

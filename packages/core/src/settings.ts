/**
 * @glance/core — engine settings.
 *
 * The server-owned, per-channel tuning knobs that change WHAT gets surfaced and
 * how often the AI speaks. Persisted by the server and broadcast to every client.
 *
 * `normalizeEngineSettings` is the single validation boundary: all external input
 * (HTTP bodies, settings files) passes through it, so the rest of the system can
 * trust that an `EngineSettings` is always well-formed and within safe bounds.
 */
export interface EngineSettings {
  /** Salience cut-off for Hybrid surfacing and "high-salience" stats. 0..1. */
  surfaceThreshold: number;
  /** Streamer-specific terms that boost a message's salience. Lowercased, deduped. */
  keywords: string[];
  /** How often the AI produces a summary, in milliseconds. */
  summaryIntervalMs: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  surfaceThreshold: 0.5,
  keywords: [],
  summaryIntervalMs: 15_000,
};

export const ENGINE_SETTINGS_BOUNDS = {
  minIntervalMs: 4_000,
  maxIntervalMs: 120_000,
  maxKeywords: 25,
  maxKeywordLength: 40,
} as const;

/** Validate and clamp arbitrary input into a safe {@link EngineSettings}. */
export function normalizeEngineSettings(input: unknown): EngineSettings {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    surfaceThreshold: round2(clamp(numberOr(obj['surfaceThreshold'], 0.5), 0, 1)),
    keywords: sanitizeKeywords(obj['keywords']),
    summaryIntervalMs: Math.round(
      clamp(
        numberOr(obj['summaryIntervalMs'], DEFAULT_ENGINE_SETTINGS.summaryIntervalMs),
        ENGINE_SETTINGS_BOUNDS.minIntervalMs,
        ENGINE_SETTINGS_BOUNDS.maxIntervalMs,
      ),
    ),
  };
}

function sanitizeKeywords(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const kw = String(item).trim().toLowerCase().slice(0, ENGINE_SETTINGS_BOUNDS.maxKeywordLength);
    if (kw.length === 0 || seen.has(kw)) continue;
    seen.add(kw);
    out.push(kw);
    if (out.length >= ENGINE_SETTINGS_BOUNDS.maxKeywords) break;
  }
  return out;
}

function numberOr(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

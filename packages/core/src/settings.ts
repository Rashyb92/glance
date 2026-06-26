import type { SalienceCategory } from './types';

/**
 * @glance/core — engine settings.
 *
 * The server-owned, per-channel tuning knobs that change WHAT gets surfaced, how
 * often the AI speaks, and — via the routing matrix — which output channel each
 * kind of moment reaches (see vs hear). Persisted by the server and broadcast to
 * every client.
 *
 * `normalizeEngineSettings` is the single validation boundary: all external input
 * (HTTP bodies, settings files) passes through it, so the rest of the system can
 * trust that an `EngineSettings` is always well-formed and within safe bounds.
 */
export type OutputChannel = 'display' | 'voice' | 'earcon';

/** Per-category output routing — which channels each salience category reaches. */
export type RoutingMatrix = Partial<Record<SalienceCategory, OutputChannel[]>>;

export interface EngineSettings {
  /** Salience cut-off for Hybrid surfacing and "high-salience" stats. 0..1. */
  surfaceThreshold: number;
  /** Streamer-specific terms that boost a message's salience. Lowercased, deduped. */
  keywords: string[];
  /** How often the AI produces a summary, in milliseconds. */
  summaryIntervalMs: number;
  /** What to see vs hear: each category maps to the channels it should reach. */
  routing: RoutingMatrix;
  /** Run the periodic AI summary pass (AI Assist / Hybrid headline). */
  aiSummaries: boolean;
  /** Run the periodic Claude re-ranking "priority" pass. */
  aiPriorities: boolean;
  /** Flag toxic / harassment messages for moderation. */
  moderation: boolean;
  /** Toxicity score (0..1) at/above which a message is flagged. Lower = stricter. */
  moderationSensitivity: number;
}

const ROUTABLE_CATEGORIES: SalienceCategory[] = [
  'donation',
  'event',
  'question',
  'trend',
  'mention',
  'moderation',
  'highlight',
  'chatter',
];
const OUTPUT_CHANNELS: OutputChannel[] = ['display', 'voice', 'earcon'];

export const DEFAULT_ROUTING: RoutingMatrix = {
  donation: ['display', 'voice', 'earcon'],
  event: ['display', 'voice', 'earcon'],
  question: ['display', 'voice'],
  mention: ['display', 'voice'],
  moderation: ['display', 'earcon'],
  trend: ['display'],
  highlight: ['display'],
  chatter: [],
};

export const ENGINE_SETTINGS_BOUNDS = {
  minIntervalMs: 4_000,
  maxIntervalMs: 120_000,
  maxKeywords: 25,
  maxKeywordLength: 40,
} as const;

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  surfaceThreshold: 0.5,
  keywords: [],
  summaryIntervalMs: 15_000,
  routing: cloneRouting(DEFAULT_ROUTING),
  aiSummaries: true,
  aiPriorities: true,
  moderation: true,
  moderationSensitivity: 0.5,
};

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
    routing: sanitizeRouting(obj['routing']),
    aiSummaries: boolOr(obj['aiSummaries'], true),
    aiPriorities: boolOr(obj['aiPriorities'], true),
    moderation: boolOr(obj['moderation'], true),
    moderationSensitivity: round2(clamp(numberOr(obj['moderationSensitivity'], 0.5), 0, 1)),
  };
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizeRouting(value: unknown): RoutingMatrix {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const out: RoutingMatrix = {};
  for (const category of ROUTABLE_CATEGORIES) {
    const raw = input[category];
    if (Array.isArray(raw)) {
      out[category] = OUTPUT_CHANNELS.filter((c) => (raw as unknown[]).includes(c));
    } else {
      out[category] = [...(DEFAULT_ROUTING[category] ?? [])];
    }
  }
  return out;
}

function cloneRouting(routing: RoutingMatrix): RoutingMatrix {
  const out: RoutingMatrix = {};
  for (const category of ROUTABLE_CATEGORIES) out[category] = [...(routing[category] ?? [])];
  return out;
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

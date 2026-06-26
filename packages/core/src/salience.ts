import type { ChatMessage, ScoredMessage, SalienceSignal, SalienceCategory } from './types';
import { analyzeSentiment } from './sentiment';
import { analyzeToxicity } from './toxicity';

/** Tuning context for the deterministic salience engine. */
export interface SalienceContext {
  /** Broadcaster login / display name, for mention detection. */
  broadcaster?: string;
  /** Extra keywords the streamer cares about (game names, segment names…). */
  keywords?: string[];
  /** How many times this message's normalized text recurred in the trend window. */
  trendCount?: number;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const QUESTION_RE =
  /\?\s*$|^(who|what|when|where|why|how|which|are|is|can|could|would|will|do|does|did|should|any)\b/i;

const NOISE_WORD_RE =
  /^(lol|lmao|lmfao|ha(ha)+|gg|ggs|ggwp|w|l|f|o7|pog|poggers|pogchamp|kekw|lul|lulw|omegalul|monkas|ez|sheesh|based|cap|nocap|fr|frfr|yo+|yoo+|hi|hello|hey|same|this|true|real|wp)$/i;

/** Heuristic: is this message just emotes / one-word reactions / shouting noise? */
export function isLikelyEmoteNoise(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  const tokenIsNoise = (w: string): boolean =>
    /^[A-Z0-9]{1,12}$/.test(w) || // ALLCAPS emote token, e.g. LUL, OMEGALUL
    NOISE_WORD_RE.test(w) ||
    /(.)\1{3,}/.test(w); // elongation: "yoooo", "!!!!", "WWWW"
  return words.every(tokenIsNoise);
}

function dominantCategory(signals: SalienceSignal[]): SalienceCategory {
  let best: SalienceSignal | undefined;
  for (const s of signals) {
    if (s.weight <= 0) continue;
    if (!best || s.weight > best.weight) best = s;
  }
  return best?.category ?? 'chatter';
}

/**
 * Score a single chat message for how much it deserves the creator's attention.
 *
 * Pure and deterministic by design — it runs with zero external calls and is the
 * floor of quality. The AI layer (see `@glance/ai`) augments this with summaries
 * and re-ranking; it never replaces it. This is the defensible core of Glance.
 */
export function scoreMessage(message: ChatMessage, ctx: SalienceContext = {}): ScoredMessage {
  const signals: SalienceSignal[] = [];
  const text = message.text.trim();
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const sentiment = analyzeSentiment(text);
  const toxicity = analyzeToxicity(text);

  // 1. Money on the table — the strongest possible signal.
  if (message.bits && message.bits > 0) {
    const weight = clamp01(0.6 + Math.log10(1 + message.bits) / 4);
    signals.push({ category: 'donation', weight, reason: `${message.bits} bits cheered` });
  }

  // 2. Direct address to the streamer.
  if (ctx.broadcaster && lower.includes(ctx.broadcaster.toLowerCase())) {
    signals.push({ category: 'mention', weight: 0.5, reason: 'addresses the streamer' });
  }

  // 3. A keyword the streamer flagged as important.
  for (const kw of ctx.keywords ?? []) {
    if (kw && lower.includes(kw.toLowerCase())) {
      signals.push({ category: 'mention', weight: 0.4, reason: `keyword: ${kw}` });
      break;
    }
  }

  // 4. A genuine question worth answering on stream.
  if (text.length > 8 && QUESTION_RE.test(text)) {
    signals.push({ category: 'question', weight: 0.5, reason: 'looks like a question' });
  }

  // 5. A trend — many people saying the same thing.
  if (ctx.trendCount && ctx.trendCount >= 3) {
    const weight = clamp01(0.3 + Math.log2(ctx.trendCount) / 6);
    signals.push({ category: 'trend', weight, reason: `repeated ${ctx.trendCount}x in chat` });
  }

  // 6. Light role boost.
  const roles = message.roles ?? [];
  if (roles.includes('broadcaster') || roles.includes('moderator')) {
    signals.push({ category: 'highlight', weight: 0.2, reason: 'from a mod or broadcaster' });
  } else if (roles.includes('vip') || roles.includes('subscriber') || roles.includes('founder')) {
    signals.push({ category: 'highlight', weight: 0.1, reason: 'from a sub or VIP' });
  }

  // 7. Substance vs. noise.
  if (words.length >= 6) {
    signals.push({ category: 'highlight', weight: 0.12, reason: 'substantial message' });
  }
  if (isLikelyEmoteNoise(text)) {
    signals.push({ category: 'chatter', weight: -0.25, reason: 'emote / one-word noise' });
  }

  // Moderation — surface flagged harassment/toxicity so the streamer or mods can act.
  if (toxicity.flagged) {
    signals.push({ category: 'moderation', weight: 0.55, reason: 'flagged for moderation' });
  }
  // Strong emotional reactions (either direction) deserve a little more attention.
  if (Math.abs(sentiment) >= 0.6) {
    signals.push({
      category: 'highlight',
      weight: 0.12,
      reason: sentiment > 0 ? 'strong positive reaction' : 'strong negative reaction',
    });
  }

  // Soft-OR aggregation: independent positive signals accumulate but saturate at 1.
  let score = 0;
  for (const s of signals) {
    if (s.weight > 0) score = score + s.weight * (1 - score);
  }
  const penalty = signals.reduce((acc, s) => (s.weight < 0 ? acc + s.weight : acc), 0);
  score = clamp01(score + penalty);

  return {
    message,
    score: round3(score),
    category: dominantCategory(signals),
    signals,
    sentiment,
    toxicity: toxicity.score,
  };
}

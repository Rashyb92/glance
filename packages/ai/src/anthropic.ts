import Anthropic from '@anthropic-ai/sdk';
import type { AudienceMood, ChatSummary, PriorityCallout, ScoredMessage } from '@glance/core';
import type { AIProvider, PrioritizeInput, SummarizeInput } from './provider';
import { RulesProvider } from './rules';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const VALID_MOODS = new Set<AudienceMood>(['hyped', 'positive', 'neutral', 'restless', 'negative']);

const SYSTEM_PROMPT = `You are Glance, a calm attention copilot worn by a live streamer.
Given a sample of their recent chat, return ONE short, useful heads-up: the single
thing they would most want to know or act on right now (a donation, a repeated
request, an important question, a shift in mood). Ignore emote spam and noise.
Respond with ONLY minified JSON of the form:
{"headline": string (<= ~80 chars), "detail": string[] (0-3 very short bullets), "mood": "hyped"|"positive"|"neutral"|"restless"|"negative"}`;

const PRIORITIZE_SYSTEM = `You are Glance, an attention copilot for a live streamer. From the numbered candidate chat messages, choose the 1-3 the streamer should act on RIGHT NOW (a donation to thank, an important question, a moderation issue, a strong request). Reply with ONLY a JSON array: [{"i": <candidate number>, "reason": "<= 8 words"}]. Fewer is better; never invent messages.`;

/**
 * Claude-powered summariser. Wraps the Anthropic SDK and degrades gracefully:
 * any error (no network, rate limit, bad key) falls back to {@link RulesProvider}
 * so the HUD never goes dark.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly fallback = new RulesProvider();

  constructor(apiKey: string, model?: string) {
    // Bound every call so a slow/hung API can't stall the summary/priority cycle.
    this.client = new Anthropic({ apiKey, timeout: 10_000, maxRetries: 1 });
    this.model = model ?? DEFAULT_MODEL;
  }

  async summarize(input: SummarizeInput): Promise<ChatSummary> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(input) }],
      });
      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
      const parsed = parseSummary(text);
      return { id: rid(), source: 'ai', timestamp: Date.now(), ...parsed };
    } catch {
      const fb = await this.fallback.summarize(input);
      return { ...fb, detail: [...(fb.detail ?? []), '(Claude unavailable — rule-based summary)'] };
    }
  }

  async prioritize(input: PrioritizeInput): Promise<PriorityCallout[]> {
    const candidates = input.candidates.slice(-20);
    if (candidates.length === 0) return [];
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        system: PRIORITIZE_SYSTEM,
        messages: [{ role: 'user', content: buildPriorityPrompt(candidates, input) }],
      });
      const text = response.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
      const picked = parsePriorities(text, candidates);
      return picked.length > 0 ? picked : this.fallback.prioritize(input);
    } catch {
      return this.fallback.prioritize(input);
    }
  }
}

function buildPrompt(input: SummarizeInput): string {
  const lines = input.recent
    .slice(-50)
    .map((s) => {
      const bits = (s.message.bits ?? 0) > 0 ? ` [${s.message.bits} bits]` : '';
      return `${s.message.author}${bits}: ${s.message.text}`;
    })
    .join('\n');
  const who = input.broadcaster ? ` The streamer is ${input.broadcaster}.` : '';
  return `Channel #${input.channel}.${who}\nRecent chat:\n${lines || '(no messages yet)'}`;
}

function parseSummary(text: string): { headline: string; detail?: string[]; mood?: AudienceMood } {
  try {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a !== -1 && b > a) {
      const obj = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
      const headline = String(obj['headline'] ?? '').trim();
      const moodRaw = String(obj['mood'] ?? '') as AudienceMood;
      return {
        headline: headline ? headline.slice(0, 100) : 'Chat update',
        detail: Array.isArray(obj['detail'])
          ? (obj['detail'] as unknown[]).slice(0, 3).map((d) => String(d))
          : undefined,
        mood: VALID_MOODS.has(moodRaw) ? moodRaw : undefined,
      };
    }
  } catch {
    /* fall through to plain-text handling */
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return { headline: flat ? flat.slice(0, 90) : 'Chat update' };
}

function buildPriorityPrompt(candidates: ScoredMessage[], input: PrioritizeInput): string {
  const lines = candidates
    .map((c, i) => {
      const bits = (c.message.bits ?? 0) > 0 ? ` [${c.message.bits} bits]` : '';
      return `${i}. (${c.category} ${c.score})${bits} ${c.message.author}: ${c.message.text}`;
    })
    .join('\n');
  const who = input.broadcaster ? ` Streamer: ${input.broadcaster}.` : '';
  return `Channel #${input.channel}.${who}\nCandidates:\n${lines}`;
}

function parsePriorities(text: string, candidates: ScoredMessage[]): PriorityCallout[] {
  try {
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a === -1 || b <= a) return [];
    const arr = JSON.parse(text.slice(a, b + 1)) as Array<{ i?: number; reason?: string }>;
    const out: PriorityCallout[] = [];
    const seen = new Set<number>();
    for (const item of arr) {
      const i = typeof item.i === 'number' ? item.i : -1;
      if (i < 0 || i >= candidates.length || seen.has(i)) continue;
      seen.add(i);
      const c = candidates[i]!;
      out.push({
        id: c.message.id,
        text: c.message.text,
        author: c.message.author,
        reason: String(item.reason ?? c.category).slice(0, 60),
        category: c.category,
        score: c.score,
        source: 'ai',
      });
      if (out.length >= 3) break;
    }
    return out;
  } catch {
    return [];
  }
}

function rid(): string {
  return Math.random().toString(36).slice(2);
}

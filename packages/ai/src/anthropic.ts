import Anthropic from '@anthropic-ai/sdk';
import type { AudienceMood, ChatSummary } from '@glance/core';
import type { AIProvider, SummarizeInput } from './provider';
import { RulesProvider } from './rules';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const VALID_MOODS = new Set<AudienceMood>(['hyped', 'positive', 'neutral', 'restless', 'negative']);

const SYSTEM_PROMPT = `You are Glance, a calm attention copilot worn by a live streamer.
Given a sample of their recent chat, return ONE short, useful heads-up: the single
thing they would most want to know or act on right now (a donation, a repeated
request, an important question, a shift in mood). Ignore emote spam and noise.
Respond with ONLY minified JSON of the form:
{"headline": string (<= ~80 chars), "detail": string[] (0-3 very short bullets), "mood": "hyped"|"positive"|"neutral"|"restless"|"negative"}`;

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
    this.client = new Anthropic({ apiKey });
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

function rid(): string {
  return Math.random().toString(36).slice(2);
}

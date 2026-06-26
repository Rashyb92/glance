import { normalizeTrendText } from '@glance/core';
import type { AudienceMood, ChatSummary, PriorityCallout, ScoredMessage } from '@glance/core';
import type { AIProvider, PrioritizeInput, SummarizeInput } from './provider';

/**
 * Deterministic, zero-dependency summariser. It runs with no API key and is also
 * the safety net the Claude provider falls back to. Never makes a network call.
 */
export class RulesProvider implements AIProvider {
  readonly name = 'rules';

  summarize(input: SummarizeInput): Promise<ChatSummary> {
    return Promise.resolve(this.build(input));
  }

  prioritize(input: PrioritizeInput): Promise<PriorityCallout[]> {
    const seen = new Set<string>();
    const out: PriorityCallout[] = [];
    for (const c of [...input.candidates].sort((a, b) => b.score - a.score)) {
      const norm = normalizeTrendText(c.message.text);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({
        id: c.message.id,
        text: c.message.text,
        author: c.message.author,
        reason: topReason(c),
        category: c.category,
        score: c.score,
        source: 'rules',
      });
      if (out.length >= 3) break;
    }
    return Promise.resolve(out);
  }

  private build(input: SummarizeInput): ChatSummary {
    const recent = input.recent;
    const detail: string[] = [];

    const donations = recent.filter((s) => (s.message.bits ?? 0) > 0);
    const bitsTotal = donations.reduce((a, s) => a + (s.message.bits ?? 0), 0);
    const questions = recent.filter((s) => s.category === 'question');

    const counts = new Map<string, { n: number; sample: string }>();
    for (const s of recent) {
      const norm = normalizeTrendText(s.message.text);
      if (norm.split(' ').filter(Boolean).length < 2) continue;
      const cur = counts.get(norm) ?? { n: 0, sample: s.message.text };
      cur.n += 1;
      counts.set(norm, cur);
    }
    let topTrend: { n: number; sample: string } | undefined;
    for (const v of counts.values()) {
      if (!topTrend || v.n > topTrend.n) topTrend = v;
    }

    const mood: AudienceMood =
      bitsTotal > 0
        ? 'hyped'
        : questions.length >= 3
          ? 'restless'
          : recent.length === 0
            ? 'neutral'
            : 'positive';

    const firstQuestion = questions[0];
    let headline: string;
    if (topTrend && topTrend.n >= 3) {
      headline = `Chat keeps saying: "${truncate(topTrend.sample, 48)}"`;
    } else if (bitsTotal > 0) {
      headline = `${donations.length} cheer${donations.length === 1 ? '' : 's'} in (${bitsTotal} bits)`;
    } else if (firstQuestion) {
      headline = `Someone asked: "${truncate(firstQuestion.message.text, 48)}"`;
    } else if (recent.length === 0) {
      headline = 'Chat is quiet right now';
    } else {
      headline = 'Steady chatter — nothing urgent';
    }

    if (firstQuestion && !headline.startsWith('Someone asked')) {
      detail.push(`Q: ${truncate(firstQuestion.message.text, 60)}`);
    }
    if (bitsTotal > 0 && !headline.includes('cheer')) {
      detail.push(`${donations.length} cheers (${bitsTotal} bits)`);
    }
    if (topTrend && topTrend.n >= 3 && !headline.startsWith('Chat keeps')) {
      detail.push(`Trend: "${truncate(topTrend.sample, 48)}" x${topTrend.n}`);
    }

    return {
      id: Math.random().toString(36).slice(2),
      headline,
      detail: detail.slice(0, 3),
      mood,
      source: 'rules',
      timestamp: Date.now(),
    };
  }
}

function topReason(scored: ScoredMessage): string {
  let best: { weight: number; reason: string } | undefined;
  for (const s of scored.signals) {
    if (s.weight <= 0) continue;
    if (!best || s.weight > best.weight) best = s;
  }
  return best?.reason ?? scored.category;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

import { normalizeTrendText } from './trends';
import type { AudienceMood, ChannelEvent, SalienceCategory, ScoredMessage } from './types';

export interface TopSupporter {
  author: string;
  bits: number;
}
export interface TrendItem {
  phrase: string;
  count: number;
}
export interface MomentItem {
  id: string;
  author: string;
  text: string;
  score: number;
  category: SalienceCategory;
}

/** A rolling snapshot of the channel — the data behind the Creator Command Center. */
export interface DashboardStats {
  channel: string;
  generatedAt: number;
  uptimeSec: number;

  // Live Pulse
  chatters: number;
  messagesPerMin: number;
  mood: AudienceMood;
  hype: number; // 0..100
  questionsWaiting: number;
  /** Average sentiment across the window, -1..1. */
  sentiment: number;
  /** Messages flagged for moderation in the window. */
  flagged: number;

  // Monetization
  bitsTotal: number;
  cheers: number;
  giftSubs: number;
  topSupporters: TopSupporter[];

  // AI Insights
  trends: TrendItem[];
  bestMoments: MomentItem[];

  // Totals / health
  messagesTotal: number;
  eventsTotal: number;
}

interface Stamped {
  scored: ScoredMessage;
  t: number;
}

/**
 * Derives {@link DashboardStats} from the live scored stream. Pure and
 * deterministic (clock is injectable) so it is fully unit-testable.
 */
export class StatsAggregator {
  private readonly startedAt: number;
  private readonly windowMs: number;
  private window: Stamped[] = [];
  private moments: MomentItem[] = [];
  private readonly supporters = new Map<string, number>();
  private messagesTotal = 0;
  private eventsTotal = 0;
  private bitsTotal = 0;
  private cheers = 0;
  private giftSubs = 0;
  private highThreshold = 0.5;

  constructor(
    private readonly channel: string,
    windowMs = 60_000,
    now: number = Date.now(),
  ) {
    this.windowMs = windowMs;
    this.startedAt = now;
  }

  /** The salience cut-off for "high-salience" counting and best-moments. */
  setThreshold(threshold: number): void {
    this.highThreshold = Math.max(0, Math.min(1, threshold));
  }

  ingestMessage(scored: ScoredMessage, now: number = Date.now()): void {
    this.messagesTotal += 1;
    const bits = scored.message.bits ?? 0;
    if (bits > 0) {
      this.bitsTotal += bits;
      this.cheers += 1;
      const author = scored.message.author;
      this.supporters.set(author, (this.supporters.get(author) ?? 0) + bits);
    }
    this.window.push({ scored, t: now });
    this.evict(now);
    this.recordMoment(scored);
  }

  ingestEvent(event: ChannelEvent): void {
    this.eventsTotal += 1;
    if (event.kind === 'gift_subs') this.giftSubs += event.magnitude ?? 1;
  }

  snapshot(now: number = Date.now()): DashboardStats {
    this.evict(now);
    const authors = new Set<string>();
    let highCount = 0;
    let questions = 0;
    let bitsWindow = 0;
    let sentimentSum = 0;
    let sentimentCount = 0;
    let flagged = 0;
    const trendCounts = new Map<string, { n: number; sample: string }>();

    for (const { scored } of this.window) {
      authors.add(scored.message.author);
      if (scored.score >= this.highThreshold) highCount += 1;
      if (scored.category === 'question') questions += 1;
      if (scored.category === 'moderation' || (scored.toxicity ?? 0) >= 0.5) flagged += 1;
      if (typeof scored.sentiment === 'number') {
        sentimentSum += scored.sentiment;
        sentimentCount += 1;
      }
      bitsWindow += scored.message.bits ?? 0;
      const norm = normalizeTrendText(scored.message.text);
      if (norm.split(' ').filter(Boolean).length >= 2) {
        const cur = trendCounts.get(norm) ?? { n: 0, sample: scored.message.text };
        cur.n += 1;
        trendCounts.set(norm, cur);
      }
    }

    const minutes = Math.max(this.windowMs / 60_000, 1 / 60);
    const avgSentiment = sentimentCount > 0 ? sentimentSum / sentimentCount : 0;
    const mood: AudienceMood =
      bitsWindow > 0
        ? 'hyped'
        : avgSentiment <= -0.25
          ? 'negative'
          : questions >= 3
            ? 'restless'
            : avgSentiment >= 0.25
              ? 'positive'
              : 'neutral';

    const trends = [...trendCounts.values()]
      .filter((v) => v.n >= 2)
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map((v) => ({ phrase: v.sample, count: v.n }));

    const topSupporters = [...this.supporters.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([author, bits]) => ({ author, bits }));

    return {
      channel: this.channel,
      generatedAt: now,
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      chatters: authors.size,
      messagesPerMin: Math.round(this.window.length / minutes),
      mood,
      hype: clampPct(Math.round(highCount * 6 + bitsWindow / 100)),
      questionsWaiting: questions,
      sentiment: Math.round(avgSentiment * 100) / 100,
      flagged,
      bitsTotal: this.bitsTotal,
      cheers: this.cheers,
      giftSubs: this.giftSubs,
      topSupporters,
      trends,
      bestMoments: this.moments.slice(0, 6),
      messagesTotal: this.messagesTotal,
      eventsTotal: this.eventsTotal,
    };
  }

  private recordMoment(scored: ScoredMessage): void {
    if (scored.score < this.highThreshold) return;
    const norm = normalizeTrendText(scored.message.text);
    const item: MomentItem = {
      id: scored.message.id,
      author: scored.message.author,
      text: scored.message.text,
      score: scored.score,
      category: scored.category,
    };
    const existing = this.moments.findIndex((m) => normalizeTrendText(m.text) === norm);
    if (existing >= 0) {
      if (scored.score > this.moments[existing]!.score) this.moments[existing] = item;
    } else {
      this.moments.push(item);
    }
    this.moments.sort((a, b) => b.score - a.score);
    if (this.moments.length > 12) this.moments.length = 12;
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.window.length > 0 && this.window[0]!.t < cutoff) this.window.shift();
  }
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

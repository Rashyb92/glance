import { scoreMessage, TrendTracker } from '@glance/core';
import type { ChatMessage, ChannelEvent, HudItem, ScoredMessage } from '@glance/core';
import type { AIProvider } from '@glance/ai';

export interface EngineOptions {
  channel: string;
  broadcaster?: string;
  keywords?: string[];
  ai: AIProvider;
  summaryIntervalMs: number;
  onItem: (item: HudItem) => void;
  /** Gate for the AI usage cap — returns false when the tenant's daily budget is spent. */
  canUseAi?: () => boolean;
}

/**
 * The pipeline. Every incoming message is scored (trend- and keyword-aware) and
 * emitted; every channel event is emitted as inherently high-salience; on a timer
 * the recent window is handed to the AI provider for a calm summary.
 *
 * Keywords and the summary interval are live-tunable (see M2 settings) without
 * tearing down the session.
 */
export class GlanceEngine {
  private readonly trends = new TrendTracker();
  private readonly recent: ScoredMessage[] = [];
  private readonly maxRecent = 120;
  private summaryTimer: NodeJS.Timeout | null = null;
  private summarizing = false;
  private keywords: string[];
  private summaryIntervalMs: number;
  private summariesEnabled = true;
  private moderation = true;
  private moderationSensitivity = 0.5;

  constructor(private readonly opts: EngineOptions) {
    this.keywords = opts.keywords ?? [];
    this.summaryIntervalMs = opts.summaryIntervalMs;
  }

  start(): void {
    this.summaryTimer = setInterval(() => void this.emitSummary(), this.summaryIntervalMs);
  }

  stop(): void {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.summaryTimer = null;
  }

  setKeywords(keywords: string[]): void {
    this.keywords = keywords;
  }

  setSummaryInterval(ms: number): void {
    this.summaryIntervalMs = ms;
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = setInterval(() => void this.emitSummary(), ms);
    }
  }

  setSummariesEnabled(enabled: boolean): void {
    this.summariesEnabled = enabled;
  }

  setModeration(enabled: boolean, sensitivity: number): void {
    this.moderation = enabled;
    this.moderationSensitivity = sensitivity;
  }

  ingestMessage(message: ChatMessage): void {
    const trendCount = this.trends.record(message.text, message.timestamp);
    const scored = scoreMessage(message, {
      broadcaster: this.opts.broadcaster,
      keywords: this.keywords,
      trendCount,
      moderation: this.moderation,
      moderationSensitivity: this.moderationSensitivity,
    });
    this.recent.push(scored);
    if (this.recent.length > this.maxRecent) this.recent.shift();
    this.opts.onItem({ type: 'message', data: scored });
  }

  ingestEvent(event: ChannelEvent): void {
    const score = event.kind === 'raid' ? 0.95 : 0.85;
    this.opts.onItem({ type: 'event', data: event, score });
  }

  snapshot(limit = 40): ScoredMessage[] {
    return this.recent.slice(-limit);
  }

  private async emitSummary(): Promise<void> {
    if (!this.summariesEnabled || this.summarizing || this.recent.length === 0) return;
    if (this.opts.canUseAi && !this.opts.canUseAi()) return; // daily AI cap reached
    this.summarizing = true;
    try {
      const summary = await this.opts.ai.summarize({
        channel: this.opts.channel,
        broadcaster: this.opts.broadcaster,
        recent: this.snapshot(50),
      });
      this.opts.onItem({ type: 'summary', data: summary });
    } catch {
      /* summaries are best-effort; never crash the pipeline */
    } finally {
      this.summarizing = false;
    }
  }
}

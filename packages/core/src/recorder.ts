import { normalizeTrendText } from './trends';
import type { ChannelEvent, ChatSummary, Platform, ScoredMessage } from './types';
import type { ReplayMoment, SessionDetail, SessionSummary, TimelineEntry } from './replay';

interface TimedMoment {
  scored: ScoredMessage;
  atSec: number;
}

/**
 * Accumulates a durable record of one live session: headline counts, the best
 * moments (deduped, top by score) and a chronological timeline. Pure — all I/O is
 * the caller's job — so it is fully unit-testable.
 */
export class SessionRecorder {
  private readonly startedAt: number;
  private messages = 0;
  private bits = 0;
  private events = 0;
  private peakChatters = 0;
  private top: TimedMoment[] = [];
  private timeline: TimelineEntry[] = [];
  private lastSummaryNorm = '';

  constructor(
    readonly id: string,
    readonly channel: string,
    readonly platform: Platform | null,
    now: number = Date.now(),
  ) {
    this.startedAt = now;
  }

  hasContent(): boolean {
    return this.messages > 0 || this.events > 0;
  }

  /** Top scored messages — used as the AI recap input. */
  topMoments(limit = 8): ScoredMessage[] {
    return this.top.slice(0, limit).map((t) => t.scored);
  }

  recordMessage(scored: ScoredMessage, now: number = Date.now()): void {
    this.messages += 1;
    const bits = scored.message.bits ?? 0;
    if (bits > 0) {
      this.bits += bits;
      this.timeline.push({
        kind: 'donation',
        atSec: this.sec(now),
        author: scored.message.author,
        bits,
      });
    }
    this.considerMoment(scored, now);
  }

  recordEvent(event: ChannelEvent, now: number = Date.now()): void {
    this.events += 1;
    this.timeline.push({
      kind: 'event',
      atSec: this.sec(now),
      eventKind: event.kind,
      summary: event.summary,
    });
  }

  recordSummary(summary: ChatSummary, now: number = Date.now()): void {
    const norm = normalizeTrendText(summary.headline);
    if (norm === this.lastSummaryNorm) return;
    this.lastSummaryNorm = norm;
    this.timeline.push({ kind: 'summary', atSec: this.sec(now), headline: summary.headline });
  }

  observeChatters(chatters: number): void {
    if (chatters > this.peakChatters) this.peakChatters = chatters;
  }

  finalize(now: number, recap: ChatSummary | null): SessionDetail {
    const top = this.top[0];
    const summary: SessionSummary = {
      id: this.id,
      channel: this.channel,
      platform: this.platform,
      startedAt: this.startedAt,
      endedAt: now,
      durationSec: Math.max(0, Math.round((now - this.startedAt) / 1000)),
      messages: this.messages,
      bits: this.bits,
      events: this.events,
      peakChatters: this.peakChatters,
      topMoment: top
        ? {
            author: top.scored.message.author,
            text: top.scored.message.text,
            score: top.scored.score,
          }
        : null,
      recapHeadline: recap?.headline ?? null,
    };
    const moments: ReplayMoment[] = this.top.slice(0, 10).map((t) => ({
      id: t.scored.message.id,
      author: t.scored.message.author,
      text: t.scored.message.text,
      score: t.scored.score,
      atSec: t.atSec,
    }));
    return { ...summary, moments, timeline: this.timeline.slice(-250), recap };
  }

  private considerMoment(scored: ScoredMessage, now: number): void {
    if (scored.score < 0.5) return;
    const norm = normalizeTrendText(scored.message.text);
    const existing = this.top.findIndex((t) => normalizeTrendText(t.scored.message.text) === norm);
    if (existing >= 0) {
      if (scored.score > this.top[existing]!.scored.score) {
        this.top[existing] = { scored, atSec: this.sec(now) };
      }
    } else {
      this.top.push({ scored, atSec: this.sec(now) });
    }
    this.top.sort((a, b) => b.scored.score - a.scored.score);
    if (this.top.length > 20) this.top.length = 20;
  }

  private sec(now: number): number {
    return Math.max(0, Math.round((now - this.startedAt) / 1000));
  }
}

import type { ChannelEventKind, ChatSummary, Platform } from './types';

/**
 * @glance/core — session replay records.
 *
 * A finished stream is archived as a {@link SessionDetail}: durable best moments,
 * a chronological timeline, headline stats and an AI recap. The list view uses
 * the lighter {@link SessionSummary} (the detail minus the heavy arrays).
 */
export interface ReplayMoment {
  id: string;
  author: string;
  text: string;
  score: number;
  /** Seconds into the session when it happened. */
  atSec: number;
}

export type TimelineEntry =
  | { kind: 'event'; atSec: number; eventKind: ChannelEventKind; summary: string }
  | { kind: 'donation'; atSec: number; author: string; bits: number }
  | { kind: 'summary'; atSec: number; headline: string };

export interface SessionSummary {
  id: string;
  channel: string;
  platform: Platform | null;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  messages: number;
  bits: number;
  events: number;
  peakChatters: number;
  topMoment: { author: string; text: string; score: number } | null;
  recapHeadline: string | null;
}

export interface SessionDetail extends SessionSummary {
  moments: ReplayMoment[];
  timeline: TimelineEntry[];
  recap: ChatSummary | null;
}

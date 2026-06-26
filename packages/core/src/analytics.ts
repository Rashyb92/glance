import type { SessionDetail } from './replay';

/**
 * @glance/core — cross-session ("advanced") analytics.
 *
 * Aggregates a tenant's archived sessions into a single report: lifetime totals,
 * per-day activity, supporter leaderboards across streams, busiest sessions, and a
 * headline history. Pure — the server feeds it `SessionDetail[]` from storage — so
 * it is fully unit-tested. Gated to the top plan tier via `advancedAnalytics`.
 */
export interface SupporterTotal {
  author: string;
  bits: number;
}
export interface BusySession {
  id: string;
  channel: string;
  startedAt: number;
  messages: number;
  bits: number;
}
export interface DailyTotal {
  day: string; // YYYY-MM-DD (UTC)
  sessions: number;
  messages: number;
  bits: number;
}
export interface HeadlineEntry {
  startedAt: number;
  headline: string;
}

export interface AnalyticsReport {
  sessions: number;
  totalMessages: number;
  totalBits: number;
  totalEvents: number;
  totalStreamSec: number;
  avgDurationSec: number;
  avgMessagesPerSession: number;
  peakChatters: number;
  topSupporters: SupporterTotal[];
  busiestSessions: BusySession[];
  recentHeadlines: HeadlineEntry[];
  perDay: DailyTotal[];
}

export function aggregateSessions(sessions: SessionDetail[]): AnalyticsReport {
  let totalMessages = 0;
  let totalBits = 0;
  let totalEvents = 0;
  let totalStreamSec = 0;
  let peakChatters = 0;
  const supporters = new Map<string, number>();
  const byDay = new Map<string, { sessions: number; messages: number; bits: number }>();

  for (const s of sessions) {
    totalMessages += s.messages;
    totalBits += s.bits;
    totalEvents += s.events;
    totalStreamSec += s.durationSec;
    if (s.peakChatters > peakChatters) peakChatters = s.peakChatters;

    for (const entry of s.timeline) {
      if (entry.kind === 'donation' && entry.author) {
        supporters.set(entry.author, (supporters.get(entry.author) ?? 0) + entry.bits);
      }
    }

    const day = new Date(s.startedAt).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { sessions: 0, messages: 0, bits: 0 };
    d.sessions += 1;
    d.messages += s.messages;
    d.bits += s.bits;
    byDay.set(day, d);
  }

  const count = sessions.length;
  const topSupporters: SupporterTotal[] = [...supporters.entries()]
    .map(([author, bits]) => ({ author, bits }))
    .sort((a, b) => b.bits - a.bits)
    .slice(0, 10);
  const busiestSessions: BusySession[] = [...sessions]
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 5)
    .map((s) => ({
      id: s.id,
      channel: s.channel,
      startedAt: s.startedAt,
      messages: s.messages,
      bits: s.bits,
    }));
  const recentHeadlines: HeadlineEntry[] = sessions
    .filter((s): s is SessionDetail & { recapHeadline: string } => Boolean(s.recapHeadline))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
    .map((s) => ({ startedAt: s.startedAt, headline: s.recapHeadline }));
  const perDay: DailyTotal[] = [...byDay.entries()]
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  return {
    sessions: count,
    totalMessages,
    totalBits,
    totalEvents,
    totalStreamSec,
    avgDurationSec: count ? Math.round(totalStreamSec / count) : 0,
    avgMessagesPerSession: count ? Math.round(totalMessages / count) : 0,
    peakChatters,
    topSupporters,
    busiestSessions,
    recentHeadlines,
    perDay,
  };
}

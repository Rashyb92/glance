import { describe, it, expect } from 'vitest';
import { aggregateSessions } from '../src/analytics';
import type { SessionDetail, TimelineEntry } from '../src/replay';

function detail(
  over: Partial<SessionDetail> & { id: string; timeline?: TimelineEntry[] },
): SessionDetail {
  const startedAt = over.startedAt ?? 0;
  return {
    id: over.id,
    channel: over.channel ?? 'c',
    platform: 'twitch',
    startedAt,
    endedAt: startedAt + 1000,
    durationSec: over.durationSec ?? 100,
    messages: over.messages ?? 0,
    bits: over.bits ?? 0,
    events: over.events ?? 0,
    peakChatters: over.peakChatters ?? 0,
    topMoment: null,
    recapHeadline: over.recapHeadline ?? null,
    moments: [],
    timeline: over.timeline ?? [],
    recap: null,
  };
}

describe('aggregateSessions', () => {
  it('returns an empty report for no sessions', () => {
    const r = aggregateSessions([]);
    expect(r.sessions).toBe(0);
    expect(r.avgDurationSec).toBe(0);
    expect(r.topSupporters).toEqual([]);
  });

  it('sums totals and computes averages', () => {
    const r = aggregateSessions([
      detail({ id: 'a', messages: 100, bits: 200, events: 2, durationSec: 600, peakChatters: 50 }),
      detail({ id: 'b', messages: 300, bits: 0, events: 1, durationSec: 1200, peakChatters: 90 }),
    ]);
    expect(r.sessions).toBe(2);
    expect(r.totalMessages).toBe(400);
    expect(r.totalBits).toBe(200);
    expect(r.totalEvents).toBe(3);
    expect(r.avgMessagesPerSession).toBe(200);
    expect(r.avgDurationSec).toBe(900);
    expect(r.peakChatters).toBe(90);
  });

  it('aggregates supporters across sessions and ranks them', () => {
    const r = aggregateSessions([
      detail({
        id: 'a',
        timeline: [
          { kind: 'donation', atSec: 1, author: 'whale', bits: 500 },
          { kind: 'donation', atSec: 2, author: 'minnow', bits: 50 },
        ],
      }),
      detail({ id: 'b', timeline: [{ kind: 'donation', atSec: 1, author: 'whale', bits: 300 }] }),
    ]);
    expect(r.topSupporters[0]).toEqual({ author: 'whale', bits: 800 });
    expect(r.topSupporters[1]).toEqual({ author: 'minnow', bits: 50 });
  });

  it('ranks busiest sessions and lists recent headlines newest-first', () => {
    const r = aggregateSessions([
      detail({ id: 'a', messages: 10, startedAt: 1000, recapHeadline: 'calm start' }),
      detail({ id: 'b', messages: 99, startedAt: 2000, recapHeadline: 'huge raid' }),
    ]);
    expect(r.busiestSessions[0]?.id).toBe('b');
    expect(r.recentHeadlines[0]?.headline).toBe('huge raid');
  });

  it('groups activity per UTC day', () => {
    const day1 = Date.parse('2026-06-26T10:00:00Z');
    const day2 = Date.parse('2026-06-27T10:00:00Z');
    const r = aggregateSessions([
      detail({ id: 'a', startedAt: day1, messages: 10 }),
      detail({ id: 'b', startedAt: day1, messages: 20 }),
      detail({ id: 'c', startedAt: day2, messages: 5 }),
    ]);
    expect(r.perDay.length).toBe(2);
    expect(r.perDay[0]).toEqual({ day: '2026-06-26', sessions: 2, messages: 30, bits: 0 });
    expect(r.perDay[1]?.day).toBe('2026-06-27');
  });
});

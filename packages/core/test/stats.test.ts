import { describe, it, expect } from 'vitest';
import { StatsAggregator } from '../src/stats';
import type { SalienceCategory, ScoredMessage } from '../src/types';

function sm(
  text: string,
  score: number,
  category: SalienceCategory,
  bits?: number,
  author = 'viewer',
): ScoredMessage {
  return {
    message: {
      id: Math.random().toString(36).slice(2),
      platform: 'demo',
      channel: 'c',
      author,
      text,
      timestamp: 1,
      bits,
    },
    score,
    category,
    signals: [],
  };
}

describe('StatsAggregator', () => {
  it('aggregates pulse, monetization and trends from the scored stream', () => {
    const agg = new StatsAggregator('c', 60_000, 1000);
    agg.ingestMessage(sm('take my bits', 0.95, 'donation', 500, 'whale'), 1000);
    agg.ingestMessage(sm('do the food challenge', 0.7, 'trend', undefined, 'a'), 1100);
    agg.ingestMessage(sm('do the food challenge', 0.7, 'trend', undefined, 'b'), 1200);

    const s = agg.snapshot(1300);
    expect(s.bitsTotal).toBe(500);
    expect(s.chatters).toBe(3);
    expect(s.mood).toBe('hyped');
    expect(s.topSupporters[0]?.author).toBe('whale');
    expect(s.trends[0]?.count).toBe(2);
    expect(s.bestMoments[0]?.score).toBe(0.95);
  });

  it('clears the rolling window but keeps cumulative totals', () => {
    const agg = new StatsAggregator('c', 1000, 0);
    agg.ingestMessage(sm('hello there friends', 0.6, 'highlight'), 0);
    const later = agg.snapshot(10_000);
    expect(later.chatters).toBe(0);
    expect(later.messagesTotal).toBe(1);
  });
});

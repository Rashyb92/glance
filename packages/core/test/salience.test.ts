import { describe, it, expect } from 'vitest';
import { scoreMessage, isLikelyEmoteNoise } from '../src/salience';
import { TrendTracker } from '../src/trends';
import { shouldSurface, makePolicy } from '../src/modes';
import type { ChatMessage } from '../src/types';

function msg(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: Math.random().toString(36).slice(2),
    platform: 'twitch',
    channel: 'test',
    author: 'viewer',
    text,
    timestamp: 1_000_000,
    ...extra,
  };
}

describe('scoreMessage', () => {
  it('scores a large cheer near the top and tags it a donation', () => {
    const s = scoreMessage(msg('take my bits!', { bits: 500 }));
    expect(s.category).toBe('donation');
    expect(s.score).toBeGreaterThan(0.9);
  });

  it('treats emote spam as low-salience noise', () => {
    const s = scoreMessage(msg('LUL LUL OMEGALUL'));
    expect(s.score).toBeLessThan(0.1);
    expect(isLikelyEmoteNoise('LUL LUL OMEGALUL')).toBe(true);
  });

  it('detects a genuine question', () => {
    const s = scoreMessage(msg('what time is the stream tomorrow?'));
    expect(s.category).toBe('question');
    expect(s.score).toBeGreaterThanOrEqual(0.5);
  });

  it('boosts a direct address to the broadcaster', () => {
    const s = scoreMessage(msg('yo Rasheed you there'), { broadcaster: 'Rasheed' });
    expect(s.category).toBe('mention');
    expect(s.score).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps a quiet one-word reply low priority', () => {
    const s = scoreMessage(msg('same'));
    expect(s.score).toBeLessThan(0.2);
  });

  it('raises salience when many people repeat the same thing', () => {
    const s = scoreMessage(msg('do the food challenge'), { trendCount: 6 });
    expect(s.category).toBe('trend');
    expect(s.score).toBeGreaterThan(0.5);
  });
});

describe('TrendTracker', () => {
  it('counts repeated normalized messages within the window', () => {
    const t = new TrendTracker(10_000);
    const now = 1_000_000;
    expect(t.record('food challenge!!', now)).toBe(1);
    expect(t.record('Food Challenge', now + 100)).toBe(2);
    expect(t.record('food challenge', now + 200)).toBe(3);
  });

  it('evicts entries that fall outside the window', () => {
    const t = new TrendTracker(1_000);
    const now = 2_000_000;
    t.record('hello', now);
    expect(t.record('hello', now + 5_000)).toBe(1);
  });
});

describe('shouldSurface', () => {
  it('passes everything in raw mode and nothing in assist mode', () => {
    const s = scoreMessage(msg('hello there everyone in chat'));
    expect(shouldSurface(s, makePolicy('raw'))).toBe(true);
    expect(shouldSurface(s, makePolicy('assist'))).toBe(false);
  });

  it('only surfaces high-salience messages in hybrid mode', () => {
    const noise = scoreMessage(msg('LUL'));
    const donation = scoreMessage(msg('gg', { bits: 200 }));
    expect(shouldSurface(noise, makePolicy('hybrid'))).toBe(false);
    expect(shouldSurface(donation, makePolicy('hybrid'))).toBe(true);
  });
});

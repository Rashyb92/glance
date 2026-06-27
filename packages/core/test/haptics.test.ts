import { describe, it, expect } from 'vitest';
import { hapticPattern } from '../src/haptics';
import type { SalienceCategory } from '../src/types';

const CATEGORIES: SalienceCategory[] = [
  'donation',
  'event',
  'question',
  'trend',
  'mention',
  'moderation',
  'highlight',
  'chatter',
];

const total = (pattern: number[]): number => pattern.reduce((a, b) => a + b, 0);

describe('hapticPattern', () => {
  it('returns a non-empty, positive vibration pattern for every category', () => {
    for (const category of CATEGORIES) {
      const pattern = hapticPattern(category);
      expect(Array.isArray(pattern)).toBe(true);
      expect(pattern.length).toBeGreaterThan(0);
      expect(pattern.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
    }
  });

  it('gives donation a multi-pulse rhythm and moderation the most urgent buzz', () => {
    const donation = hapticPattern('donation');
    const moderation = hapticPattern('moderation');
    expect(donation.length).toBeGreaterThan(1); // a double-tap, not a single blip
    // The mod alert is the single strongest, most sustained signal.
    expect(Math.max(...moderation)).toBeGreaterThanOrEqual(Math.max(...donation));
    expect(total(moderation)).toBeGreaterThanOrEqual(200);
  });

  it('is deterministic', () => {
    expect(hapticPattern('question')).toEqual(hapticPattern('question'));
  });
});

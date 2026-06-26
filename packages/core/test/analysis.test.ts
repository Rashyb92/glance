import { describe, it, expect } from 'vitest';
import { analyzeSentiment } from '../src/sentiment';
import { analyzeToxicity } from '../src/toxicity';

describe('analyzeSentiment', () => {
  it('reads positive and negative charge', () => {
    expect(analyzeSentiment('i love this stream so good')).toBeGreaterThan(0.3);
    expect(analyzeSentiment('this is terrible and boring, i hate it')).toBeLessThan(-0.3);
  });

  it('handles simple negation', () => {
    expect(analyzeSentiment('not bad at all')).toBeGreaterThanOrEqual(0);
  });

  it('is neutral with no sentiment words', () => {
    expect(analyzeSentiment('what time is the stream')).toBe(0);
  });
});

describe('analyzeToxicity', () => {
  it('flags harassment and self-harm encouragement', () => {
    expect(analyzeToxicity('kys loser').flagged).toBe(true);
    expect(analyzeToxicity('you are an idiot').flagged).toBe(true);
  });

  it('does not flag ordinary or positive chat', () => {
    expect(analyzeToxicity('this is great, love it').flagged).toBe(false);
    expect(analyzeToxicity('AMAZING play').flagged).toBe(false);
  });
});

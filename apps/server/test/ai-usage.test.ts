import { describe, it, expect } from 'vitest';
import { AiUsageMeter } from '../src/ai-usage';

const at = (time: string): Date => new Date(`2026-06-26T${time}Z`);

describe('AiUsageMeter', () => {
  it('allows up to the cap, then denies', () => {
    const m = new AiUsageMeter();
    const now = at('10:00:00');
    expect(m.tryConsume('a', 2, now)).toBe(true);
    expect(m.tryConsume('a', 2, now)).toBe(true);
    expect(m.tryConsume('a', 2, now)).toBe(false);
  });

  it('meters tenants independently', () => {
    const m = new AiUsageMeter();
    const now = at('10:00:00');
    expect(m.tryConsume('a', 1, now)).toBe(true);
    expect(m.tryConsume('a', 1, now)).toBe(false);
    expect(m.tryConsume('b', 1, now)).toBe(true); // a's budget doesn't affect b
  });

  it('resets at the start of a new UTC day', () => {
    const m = new AiUsageMeter();
    expect(m.tryConsume('a', 1, at('23:59:59'))).toBe(true);
    expect(m.tryConsume('a', 1, at('23:59:59'))).toBe(false);
    expect(m.tryConsume('a', 1, new Date('2026-06-27T00:00:01Z'))).toBe(true); // new day
  });

  it('treats a zero or negative cap as no AI', () => {
    const m = new AiUsageMeter();
    expect(m.tryConsume('a', 0, at('10:00:00'))).toBe(false);
    expect(m.tryConsume('a', -5, at('10:00:00'))).toBe(false);
  });
});

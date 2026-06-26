import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/ratelimit';

describe('RateLimiter', () => {
  it('allows up to capacity, then denies', () => {
    const rl = new RateLimiter(3, 0); // capacity 3, no refill
    expect(rl.allow('ip', 1, 1000)).toBe(true);
    expect(rl.allow('ip', 1, 1000)).toBe(true);
    expect(rl.allow('ip', 1, 1000)).toBe(true);
    expect(rl.allow('ip', 1, 1000)).toBe(false);
  });

  it('refills over elapsed time', () => {
    const rl = new RateLimiter(2, 1); // 1 token/sec
    expect(rl.allow('ip', 1, 0)).toBe(true);
    expect(rl.allow('ip', 1, 0)).toBe(true);
    expect(rl.allow('ip', 1, 0)).toBe(false);
    expect(rl.allow('ip', 1, 1000)).toBe(true); // +1 token after 1s
    expect(rl.allow('ip', 1, 1000)).toBe(false);
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter(1, 0);
    expect(rl.allow('a', 1, 0)).toBe(true);
    expect(rl.allow('a', 1, 0)).toBe(false);
    expect(rl.allow('b', 1, 0)).toBe(true); // a's exhaustion doesn't affect b
  });

  it('sweeps idle buckets so memory is bounded', () => {
    const rl = new RateLimiter(1, 0);
    rl.allow('a', 1, 0);
    expect(rl.size()).toBe(1);
    rl.sweep(1000, 5000); // 'a' idle 5s > 1s threshold
    expect(rl.size()).toBe(0);
  });
});

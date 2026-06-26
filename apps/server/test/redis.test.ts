import { describe, it, expect } from 'vitest';
import type { ServerMessage } from '@glance/core';
import { RedisBus } from '../src/redis-bus';
import { RedisUsageMeter } from '../src/ai-usage';
import { RedisRateLimiter } from '../src/ratelimit';
import type { RedisCounters, RedisPubSub } from '../src/redis';

function fakePubSub(): {
  publisher: RedisPubSub;
  subscriber: RedisPubSub;
  deliver: (message: string) => void;
} {
  let listener: ((message: string) => void) | null = null;
  const subscriber: RedisPubSub = {
    publish: () => undefined,
    subscribe: (_ch, l) => {
      listener = l;
    },
  };
  const publisher: RedisPubSub = {
    publish: (_ch, m) => listener?.(m),
    subscribe: () => undefined,
  };
  return { publisher, subscriber, deliver: (m) => listener?.(m) };
}

function fakeCounters(): RedisCounters {
  const store = new Map<string, number>();
  return {
    incr: (k) => Promise.resolve(((): number => {
      const n = (store.get(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    })()),
    pExpire: () => Promise.resolve(undefined),
  };
}

const hello = (ts: number): ServerMessage => ({ type: 'hello', data: { ts } });

describe('RedisBus', () => {
  it('round-trips a published message to subscribers, keyed by tenant', () => {
    const { publisher, subscriber } = fakePubSub();
    const bus = new RedisBus(publisher, subscriber);
    const got: Array<{ tenant: string; type: string }> = [];
    bus.subscribe((tenant, msg) => got.push({ tenant, type: msg.type }));
    bus.publish('acme', hello(1));
    expect(got).toEqual([{ tenant: 'acme', type: 'hello' }]);
  });

  it('ignores malformed payloads', () => {
    const { publisher, subscriber, deliver } = fakePubSub();
    const bus = new RedisBus(publisher, subscriber);
    let count = 0;
    bus.subscribe(() => {
      count += 1;
    });
    deliver('not json');
    expect(count).toBe(0);
  });
});

describe('RedisUsageMeter', () => {
  it('allows up to the cap, then denies — per tenant/day', async () => {
    const m = new RedisUsageMeter(fakeCounters());
    const now = new Date('2026-06-26T10:00:00Z');
    expect(await m.tryConsume('a', 2, now)).toBe(true);
    expect(await m.tryConsume('a', 2, now)).toBe(true);
    expect(await m.tryConsume('a', 2, now)).toBe(false);
    expect(await m.tryConsume('b', 2, now)).toBe(true); // independent tenant
  });

  it('resets on a new UTC day and treats cap<=0 as no AI', async () => {
    const m = new RedisUsageMeter(fakeCounters());
    expect(await m.tryConsume('a', 1, new Date('2026-06-26T23:00:00Z'))).toBe(true);
    expect(await m.tryConsume('a', 1, new Date('2026-06-26T23:00:00Z'))).toBe(false);
    expect(await m.tryConsume('a', 1, new Date('2026-06-27T00:01:00Z'))).toBe(true);
    expect(await m.tryConsume('a', 0, new Date('2026-06-27T00:01:00Z'))).toBe(false);
  });
});

describe('RedisRateLimiter', () => {
  it('allows up to the limit within a window, then denies', async () => {
    const rl = new RedisRateLimiter(fakeCounters(), 2, 1000);
    expect(await rl.allow('ip', 1000)).toBe(true);
    expect(await rl.allow('ip', 1000)).toBe(true);
    expect(await rl.allow('ip', 1000)).toBe(false);
  });

  it('resets in the next window', async () => {
    const rl = new RedisRateLimiter(fakeCounters(), 1, 1000);
    expect(await rl.allow('ip', 1000)).toBe(true);
    expect(await rl.allow('ip', 1000)).toBe(false);
    expect(await rl.allow('ip', 2000)).toBe(true); // next window
  });
});

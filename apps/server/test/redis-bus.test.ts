import { describe, it, expect } from 'vitest';
import { RedisBus } from '../src/redis-bus';
import type { RedisPubSub } from '../src/redis';
import type { ServerMessage } from '@glance/core';

/** An in-process stand-in for a shared Redis channel, so we can wire two "instances" together. */
class FakeChannel {
  private readonly listeners: Array<(raw: string) => void> = [];
  publish(_channel: string, raw: string): void {
    for (const listener of this.listeners) listener(raw);
  }
  subscribe(_channel: string, listener: (raw: string) => void): void {
    this.listeners.push(listener);
  }
}
const pubsub = (ch: FakeChannel): RedisPubSub => ({
  publish: (c, m) => ch.publish(c, m),
  subscribe: (c, l) => ch.subscribe(c, l),
});

const msg = { type: 'settings', data: {} } as unknown as ServerMessage;

describe('RedisBus', () => {
  it('delivers locally even when the Redis publish throws (Redis down)', () => {
    const broken: RedisPubSub = {
      publish: () => {
        throw new Error('redis down');
      },
      subscribe: () => undefined,
    };
    const bus = new RedisBus(broken, broken);
    const got: string[] = [];
    bus.subscribe((tenant) => got.push(tenant));
    expect(() => bus.publish('t1', msg)).not.toThrow();
    expect(got).toEqual(['t1']); // local delivery survived a dead Redis
  });

  it('fans out to other instances without echoing to itself', () => {
    const ch = new FakeChannel();
    const a = new RedisBus(pubsub(ch), pubsub(ch));
    const b = new RedisBus(pubsub(ch), pubsub(ch));
    const aGot: string[] = [];
    const bGot: string[] = [];
    a.subscribe((t) => aGot.push(t));
    b.subscribe((t) => bGot.push(t));
    a.publish('t1', msg);
    expect(aGot).toEqual(['t1']); // exactly once (local) — no self-echo double-delivery
    expect(bGot).toEqual(['t1']); // the other instance received the fan-out
  });
});

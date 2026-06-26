import { describe, it, expect } from 'vitest';
import type { ServerMessage } from '@glance/core';
import { Notifier, type PushProvider } from '../src/push';
import type { PushStore, PushSubscription } from '../src/push-store';

function fakeStore(subs: PushSubscription[]): PushStore {
  return { list: () => subs } as unknown as PushStore;
}
function recorder(): { provider: PushProvider; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    provider: {
      send: async (_s, n) => {
        sent.push(n.tag);
      },
    },
  };
}

const sub: PushSubscription = { id: '1', platform: 'webhook', endpoint: 'https://h/x', createdAt: 0 };
const raid = (id: string): ServerMessage => ({
  type: 'event',
  data: { id, platform: 'twitch', channel: 'c', kind: 'raid', summary: 'raid', timestamp: 0 },
  score: 0.9,
});

describe('Notifier', () => {
  it('pushes a push-worthy moment to registered devices', () => {
    const { provider, sent } = recorder();
    new Notifier(fakeStore([sub]), provider, 0).consider('acme', raid('e1'), 1000);
    expect(sent).toEqual(['evt:e1']);
  });

  it('dedups the same moment', () => {
    const { provider, sent } = recorder();
    const n = new Notifier(fakeStore([sub]), provider, 0);
    n.consider('acme', raid('e1'), 1000);
    n.consider('acme', raid('e1'), 1001);
    expect(sent).toEqual(['evt:e1']);
  });

  it('rate-limits within the min interval', () => {
    const { provider, sent } = recorder();
    const n = new Notifier(fakeStore([sub]), provider, 5000);
    n.consider('acme', raid('e1'), 1000);
    n.consider('acme', raid('e2'), 2000); // within the 5s window
    expect(sent).toEqual(['evt:e1']);
  });

  it('does nothing when no devices are registered', () => {
    const { provider, sent } = recorder();
    new Notifier(fakeStore([]), provider, 0).consider('acme', raid('e1'), 1000);
    expect(sent).toEqual([]);
  });
});

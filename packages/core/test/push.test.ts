import { describe, it, expect } from 'vitest';
import { pushNotificationFor } from '../src/push';
import type { ServerMessage } from '../src/protocol';

describe('pushNotificationFor', () => {
  it('shapes a push from the top priority callout', () => {
    const msg: ServerMessage = {
      type: 'priorities',
      data: [
        {
          id: 'p1',
          author: 'Whale',
          text: 'when is the next stream?',
          category: 'question',
          reason: 'direct question',
          score: 0.9,
          source: 'ai',
        },
        {
          id: 'p2',
          author: 'x',
          text: 'y',
          category: 'mention',
          reason: '',
          score: 0.6,
          source: 'rules',
        },
      ],
    };
    const n = pushNotificationFor(msg);
    expect(n?.title).toBe('Worth answering');
    expect(n?.body).toContain('Whale');
    expect(n?.category).toBe('question');
    expect(n?.tag).toBe('prio:p1');
  });

  it('shapes a push from a channel event', () => {
    const msg: ServerMessage = {
      type: 'event',
      data: {
        id: 'e1',
        platform: 'twitch',
        channel: 'c',
        kind: 'raid',
        summary: 'raid: 200 viewers',
        timestamp: 0,
      },
      score: 0.95,
    };
    const n = pushNotificationFor(msg);
    expect(n?.title).toBe('Raid incoming');
    expect(n?.body).toBe('raid: 200 viewers');
    expect(n?.tag).toBe('evt:e1');
  });

  it('ignores non-push messages and empty priorities', () => {
    const session: ServerMessage = {
      type: 'session',
      data: { channel: null, demo: true, connected: false, platform: null, since: null, viewers: null },
    };
    expect(pushNotificationFor(session)).toBeNull();
    expect(pushNotificationFor({ type: 'priorities', data: [] })).toBeNull();
  });

  it('truncates long bodies to a notification-friendly length', () => {
    const n = pushNotificationFor({
      type: 'event',
      data: {
        id: 'e',
        platform: 'twitch',
        channel: 'c',
        kind: 'announcement',
        summary: 'x'.repeat(300),
        timestamp: 0,
      },
      score: 0.8,
    });
    expect((n?.body.length ?? 0) <= 140).toBe(true);
  });
});

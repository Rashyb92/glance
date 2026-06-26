import { describe, it, expect } from 'vitest';
import {
  buildChatSubscription,
  eventSubToChatMessage,
  rolesFromEventSubBadges,
} from '../src/twitch-eventsub';

const sampleEvent = {
  broadcaster_user_id: '1',
  broadcaster_user_login: 'streamer',
  chatter_user_id: '42',
  chatter_user_login: 'viewer',
  chatter_user_name: 'Viewer',
  message_id: 'abc-123',
  message: { text: 'hello world', fragments: [] },
  color: '#FF0000',
  badges: [
    { set_id: 'subscriber', id: '12', info: '12' },
    { set_id: 'moderator', id: '1', info: '' },
  ],
  cheer: { bits: 100 },
};

describe('eventSubToChatMessage', () => {
  it('maps a chat event to a normalized ChatMessage', () => {
    const m = eventSubToChatMessage('streamer', sampleEvent);
    expect(m.id).toBe('abc-123');
    expect(m.platform).toBe('twitch');
    expect(m.channel).toBe('streamer');
    expect(m.author).toBe('Viewer');
    expect(m.authorId).toBe('42');
    expect(m.text).toBe('hello world');
    expect(m.bits).toBe(100);
    expect(m.color).toBe('#FF0000');
    expect(m.roles).toEqual(['moderator', 'subscriber']);
  });

  it('tolerates a minimal event (missing optional fields)', () => {
    const m = eventSubToChatMessage('c', { message: { text: 'hi' } });
    expect(m.text).toBe('hi');
    expect(m.author).toBe('unknown');
    expect(m.bits).toBeUndefined();
    expect(m.roles).toEqual([]);
    expect(m.id.length).toBeGreaterThan(0);
  });
});

describe('rolesFromEventSubBadges', () => {
  it('extracts known roles from set_ids and ignores junk', () => {
    expect(rolesFromEventSubBadges([{ set_id: 'broadcaster' }, { set_id: 'vip' }])).toEqual([
      'broadcaster',
      'vip',
    ]);
    expect(rolesFromEventSubBadges('nope')).toEqual([]);
    expect(rolesFromEventSubBadges([{ nope: 1 }, 42])).toEqual([]);
  });
});

describe('buildChatSubscription', () => {
  it('builds a websocket-transport channel.chat.message subscription', () => {
    const sub = buildChatSubscription('1', '42', 'sess-9');
    expect(sub).toEqual({
      type: 'channel.chat.message',
      version: '1',
      condition: { broadcaster_user_id: '1', user_id: '42' },
      transport: { method: 'websocket', session_id: 'sess-9' },
    });
  });
});

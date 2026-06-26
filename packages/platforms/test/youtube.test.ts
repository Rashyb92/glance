import { describe, it, expect } from 'vitest';
import { rolesFromYouTube, youtubeToChatMessage } from '../src/youtube';

describe('youtubeToChatMessage', () => {
  it('maps a text message with roles', () => {
    const m = youtubeToChatMessage('chan', {
      id: 'yt-1',
      snippet: { displayMessage: 'hello youtube', type: 'textMessageEvent' },
      authorDetails: { channelId: 'UC123', displayName: 'Viewer', isChatModerator: true },
    });
    expect(m.id).toBe('yt-1');
    expect(m.platform).toBe('youtube');
    expect(m.author).toBe('Viewer');
    expect(m.authorId).toBe('UC123');
    expect(m.text).toBe('hello youtube');
    expect(m.roles).toEqual(['moderator']);
    expect(m.bits).toBeUndefined();
  });

  it('maps a Super Chat amount to positive bits', () => {
    const m = youtubeToChatMessage('chan', {
      id: 'yt-2',
      snippet: { displayMessage: 'take my money', superChatDetails: { amountMicros: '5000000' } },
      authorDetails: { channelId: 'UC9', displayName: 'Whale', isChatOwner: true },
    });
    expect(m.bits).toBe(500); // 5,000,000 micros / 10,000 = 500 cents ($5)
    expect(m.roles).toEqual(['broadcaster']);
  });

  it('tolerates a minimal item', () => {
    const m = youtubeToChatMessage('c', {});
    expect(m.author).toBe('unknown');
    expect(m.text).toBe('');
    expect(m.roles).toEqual([]);
    expect(m.id.length).toBeGreaterThan(0);
  });
});

describe('rolesFromYouTube', () => {
  it('maps owner / sponsor', () => {
    expect(rolesFromYouTube({ isChatOwner: true, isChatSponsor: true })).toEqual([
      'broadcaster',
      'subscriber',
    ]);
    expect(rolesFromYouTube({})).toEqual([]);
  });
});

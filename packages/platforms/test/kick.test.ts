import { describe, it, expect } from 'vitest';
import { kickToChatMessage, rolesFromKick } from '../src/kick';

describe('kickToChatMessage', () => {
  it('maps a chat message with roles and color', () => {
    const m = kickToChatMessage('chan', {
      id: 'k-1',
      content: 'hello kick',
      sender: {
        id: 42,
        username: 'Viewer',
        identity: { color: '#00FF00', badges: [{ type: 'moderator' }, { type: 'subscriber' }] },
      },
    });
    expect(m.id).toBe('k-1');
    expect(m.platform).toBe('kick');
    expect(m.author).toBe('Viewer');
    expect(m.authorId).toBe('42');
    expect(m.text).toBe('hello kick');
    expect(m.color).toBe('#00FF00');
    expect(m.roles).toEqual(['moderator', 'subscriber']);
  });

  it('tolerates a minimal payload', () => {
    const m = kickToChatMessage('c', {});
    expect(m.author).toBe('unknown');
    expect(m.text).toBe('');
    expect(m.roles).toEqual([]);
    expect(m.id.length).toBeGreaterThan(0);
  });
});

describe('rolesFromKick', () => {
  it('maps badge types and ignores junk', () => {
    expect(rolesFromKick([{ type: 'broadcaster' }, { type: 'vip' }])).toEqual([
      'broadcaster',
      'vip',
    ]);
    expect(rolesFromKick('nope')).toEqual([]);
    expect(rolesFromKick([{ nope: 1 }, 7])).toEqual([]);
  });
});

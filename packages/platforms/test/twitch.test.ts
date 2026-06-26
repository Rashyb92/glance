import { describe, it, expect } from 'vitest';
import { parseIrcLine, toChatMessage, toChannelEvent } from '../src/twitch';

describe('parseIrcLine', () => {
  it('parses tags, prefix, command, params and trailing', () => {
    const m = parseIrcLine(
      '@id=1;display-name=Foo :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hello world',
    );
    expect(m.command).toBe('PRIVMSG');
    expect(m.params[0]).toBe('#chan');
    expect(m.params[1]).toBe('hello world');
    expect(m.tags['display-name']).toBe('Foo');
  });

  it('handles a bare PING', () => {
    expect(parseIrcLine('PING :tmi.twitch.tv').command).toBe('PING');
  });
});

describe('toChatMessage', () => {
  it('extracts bits, author, roles and text', () => {
    const msg = toChatMessage(
      'streamer',
      parseIrcLine(
        '@bits=100;display-name=Cheer;badges=moderator/1;mod=1;id=x :c!c@c.tmi.twitch.tv PRIVMSG #streamer :cheer100 nice',
      ),
    );
    expect(msg.author).toBe('Cheer');
    expect(msg.bits).toBe(100);
    expect(msg.text).toBe('cheer100 nice');
    expect(msg.roles).toContain('moderator');
  });
});

describe('toChannelEvent', () => {
  it('parses a raid with viewer count and unescaped system-msg', () => {
    const e = toChannelEvent(
      's',
      parseIrcLine(
        '@msg-id=raid;msg-param-viewerCount=312;msg-param-displayName=Big;system-msg=312\\sraiders :tmi.twitch.tv USERNOTICE #s',
      ),
    );
    expect(e?.kind).toBe('raid');
    expect(e?.magnitude).toBe(312);
    expect(e?.summary).toContain('312 raiders');
  });

  it('returns null for non-event usernotices', () => {
    expect(
      toChannelEvent('s', parseIrcLine('@msg-id=somethingelse :tmi.twitch.tv USERNOTICE #s')),
    ).toBeNull();
  });
});

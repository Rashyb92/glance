import { describe, it, expect } from 'vitest';
import { originAllowed, corsHeaders, parseChannels } from '../src/gateway';

describe('originAllowed', () => {
  it('allows no-origin (native / CLI clients) and the default localhost origins', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('http://localhost:5173')).toBe(true);
    expect(originAllowed('http://localhost:5174')).toBe(true);
  });

  it('blocks an unknown browser origin', () => {
    expect(originAllowed('https://evil.example')).toBe(false);
  });
});

describe('corsHeaders', () => {
  it('reflects an allowed origin', () => {
    expect(corsHeaders('http://localhost:5173')['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
  });

  it('omits the allow-origin header for a disallowed origin', () => {
    expect(corsHeaders('https://evil.example')['access-control-allow-origin']).toBeUndefined();
  });
});

describe('parseChannels (unified multi-channel connect)', () => {
  it('parses a single channel + platform (back-compat)', () => {
    expect(parseChannels({ channel: 'xqc', platform: 'twitch' })).toEqual([
      { platform: 'twitch', channel: 'xqc' },
    ]);
  });

  it('defaults an unspecified platform to twitch', () => {
    expect(parseChannels({ channel: 'pokimane' })).toEqual([
      { platform: 'twitch', channel: 'pokimane' },
    ]);
  });

  it('parses a multi-channel array in order', () => {
    expect(
      parseChannels({
        channels: [
          { channel: 'a', platform: 'twitch' },
          { channel: 'b', platform: 'youtube' },
          { channel: 'c', platform: 'kick' },
        ],
      }),
    ).toEqual([
      { platform: 'twitch', channel: 'a' },
      { platform: 'youtube', channel: 'b' },
      { platform: 'kick', channel: 'c' },
    ]);
  });

  it('skips blank entries and normalizes unknown platforms to twitch', () => {
    expect(
      parseChannels({
        channels: [{ channel: '  ', platform: 'twitch' }, { channel: 'good', platform: 'mystery' }, { x: 1 }],
      }),
    ).toEqual([{ platform: 'twitch', channel: 'good' }]);
  });

  it('returns no sources for an empty / demo-only request', () => {
    expect(parseChannels({})).toEqual([]);
    expect(parseChannels({ channel: '   ' })).toEqual([]);
  });
});

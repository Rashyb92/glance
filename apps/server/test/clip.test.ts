import { describe, it, expect } from 'vitest';
import { createTwitchClip } from '../src/clip';

function res(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('createTwitchClip', () => {
  it('resolves the broadcaster from the token, then creates a clip and returns the edit URL', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.includes('/helix/users')) return res(true, { data: [{ id: '12345' }] });
      if (u.includes('/helix/clips'))
        return res(true, {
          data: [{ id: 'AbcClip', edit_url: 'https://clips.twitch.tv/AbcClip/edit' }],
        });
      return res(false, {});
    }) as unknown as typeof fetch;

    const r = await createTwitchClip('client-1', 'token-1', fakeFetch);
    expect(r.ok).toBe(true);
    expect(r.id).toBe('AbcClip');
    expect(r.url).toBe('https://clips.twitch.tv/AbcClip/edit');
    expect(calls[0]).toContain('GET https://api.twitch.tv/helix/users');
    expect(calls[1]).toContain('POST https://api.twitch.tv/helix/clips?broadcaster_id=12345');
  });

  it('falls back to a canonical clip URL when no edit_url is returned', async () => {
    const fakeFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/helix/users')) return res(true, { data: [{ id: '9' }] });
      return res(true, { data: [{ id: 'Xyz' }] });
    }) as unknown as typeof fetch;
    const r = await createTwitchClip('c', 't', fakeFetch);
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://clips.twitch.tv/Xyz');
  });

  it('fails soft when the clip endpoint errors (e.g. missing clips:edit scope)', async () => {
    const fakeFetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/helix/users')) return res(true, { data: [{ id: '9' }] });
      return res(false, {}, 401);
    }) as unknown as typeof fetch;
    const r = await createTwitchClip('c', 't', fakeFetch);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('clips 401');
  });

  it('fails soft when the token resolves no broadcaster', async () => {
    const fakeFetch = (async () => res(true, { data: [] })) as unknown as typeof fetch;
    const r = await createTwitchClip('c', 't', fakeFetch);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no broadcaster');
  });

  it('fails soft when fetch throws', async () => {
    const fakeFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await createTwitchClip('c', 't', fakeFetch);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('network down');
  });
});

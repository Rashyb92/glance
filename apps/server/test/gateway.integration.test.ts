import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGateway, type Gateway, type GatewayControl } from '../src/gateway';
import type { Bus } from '../src/bus';
import { DEFAULT_ENGINE_SETTINGS, type SessionState } from '@glance/core';

// Real HTTP-level test: start the gateway on a port and drive its routes with fetch,
// using a fake control. Dev mode (no GLANCE_AUTH_SECRET) → every token resolves as owner.
const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}`;
const session: SessionState = {
  channel: null,
  demo: true,
  connected: false,
  platform: null,
  since: null,
  viewers: null,
  channels: [],
};
const calls: string[] = [];
let gw: Gateway;

beforeAll(() => {
  const bus: Bus = { publish: () => undefined, subscribe: () => undefined };
  const control: GatewayControl = {
    getSnapshot: () => [],
    getSession: () => session,
    connect: () => session,
    connectMany: (_t, sources) => {
      calls.push(`connectMany:${sources.length}`);
      return session;
    },
    disconnect: () => session,
    mark: () => Promise.resolve({ clipUrl: 'https://clips.twitch.tv/x' }),
    getSettings: () => DEFAULT_ENGINE_SETTINGS,
    updateSettings: () => DEFAULT_ENGINE_SETTINGS,
    listSessions: () => [],
    getReplay: () => null,
    deleteReplay: () => undefined,
    exportAll: () => [],
    deleteByChannel: () => 0,
    analytics: () => null,
    listTeam: () => [],
    inviteMember: () => ({ error: 'nope' }),
    removeMember: () => true,
    revokeMember: () => true,
    memberActive: () => true,
    sessionActive: () => true,
    listPush: () => [],
    subscribePush: () => ({ error: 'nope' }),
    removePush: () => true,
  };
  gw = startGateway(PORT, control, bus);
});

afterAll(() => gw.close());

describe('gateway HTTP routes (integration)', () => {
  it('serves health and ready', async () => {
    expect(await (await fetch(`${BASE}/health`)).json()).toEqual({ ok: true });
    expect(await (await fetch(`${BASE}/ready`)).json()).toEqual({ ready: true });
  });

  it('applies the security headers to responses', async () => {
    const r = await fetch(`${BASE}/health`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('returns the session and settings', async () => {
    expect(await (await fetch(`${BASE}/api/session`)).json()).toMatchObject({ demo: true, channels: [] });
    expect(await (await fetch(`${BASE}/api/settings`)).json()).toHaveProperty('surfaceThreshold');
  });

  it('connects via a channels[] body (connectMany) and marks a moment', async () => {
    const r = await fetch(`${BASE}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: [{ platform: 'twitch', channel: 'xqc' }], demo: false }),
    });
    expect(r.status).toBe(200);
    expect(calls).toContain('connectMany:1');
    const mark = await (await fetch(`${BASE}/api/mark`, { method: 'POST' })).json();
    expect(mark).toMatchObject({ ok: true, clipUrl: 'https://clips.twitch.tv/x' });
  });

  it('404s an unknown route', async () => {
    expect((await fetch(`${BASE}/api/nope`)).status).toBe(404);
  });
});

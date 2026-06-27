import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionDetail } from '@glance/core';
import { MemoryKvStore } from '../src/kv';
import { KvCache } from '../src/kv-cache';
import { KvStorage } from '../src/storage';
import { TeamStore } from '../src/team-store';
import { PushStore } from '../src/push-store';
import { EntitlementStore } from '../src/integrations/entitlement-store';
import { TokenStore } from '../src/integrations/oauth-token-store';

/** Flush the microtask + timer queue so a background hydrate has resolved. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'glance-kv-'));

describe('KvCache', () => {
  it('writes through to the store and reads back synchronously', async () => {
    const kv = new MemoryKvStore();
    const a = new KvCache(kv);
    a.write('k', 'v1');
    expect(a.read('k')).toBe('v1');
    expect(await kv.get('k')).toBe('v1');
  });

  it('hydrates a cold key from the store on a fresh instance', async () => {
    const kv = new MemoryKvStore();
    await kv.put('k', 'stored');
    const b = new KvCache(kv);
    expect(b.read('k')).toBeNull(); // cold read kicks off a background hydrate
    await tick();
    expect(b.read('k')).toBe('stored');
  });

  it('never lets a slower hydrate clobber a fresh write', async () => {
    const kv = new MemoryKvStore();
    await kv.put('k', 'old');
    const c = new KvCache(kv);
    expect(c.read('k')).toBeNull(); // starts hydrating "old"
    c.write('k', 'new'); // write wins the race
    await tick();
    expect(c.read('k')).toBe('new');
  });
});

describe('TeamStore (KV-backed)', () => {
  it('persists invites to the store and hydrates on a new instance', async () => {
    const kv = new MemoryKvStore();
    const a = new TeamStore(tmp(), kv);
    const invited = a.invite('tenantA', 'mod@example.com', 'member', 5);
    expect('id' in invited).toBe(true);
    expect(a.list('tenantA')).toHaveLength(1);

    const b = new TeamStore(tmp(), kv); // different dir, same KV
    expect(b.list('tenantA')).toHaveLength(0); // cold
    await tick();
    expect(b.list('tenantA')).toHaveLength(1); // hydrated
    expect(b.list('tenantA')[0]?.email).toBe('mod@example.com');
  });

  it('keeps tenants isolated', () => {
    const kv = new MemoryKvStore();
    const s = new TeamStore(tmp(), kv);
    s.invite('t1', 'a@example.com', 'member', 5);
    expect(s.list('t2')).toEqual([]);
  });
});

describe('PushStore (KV-backed)', () => {
  it('persists device subscriptions and supports removal', async () => {
    const kv = new MemoryKvStore();
    const a = new PushStore(tmp(), kv);
    const sub = a.subscribe('t1', 'apns', 'device-token-abc');
    expect('id' in sub).toBe(true);
    expect(a.list('t1')).toHaveLength(1);

    const b = new PushStore(tmp(), kv);
    expect(b.list('t1')).toHaveLength(0);
    await tick();
    expect(b.list('t1')).toHaveLength(1);

    if ('id' in sub) expect(a.remove('t1', sub.id)).toBe(true);
    expect(a.list('t1')).toEqual([]);
  });
});

describe('EntitlementStore (KV-backed)', () => {
  it('persists plans and warms them via hydrate()', async () => {
    const kv = new MemoryKvStore();
    const a = new EntitlementStore(tmp(), kv);
    a.setPlan('t1', 'pro', 'cus_123');
    expect(a.getPlan('t1')).toBe('pro');
    expect(a.customerId('t1')).toBe('cus_123');

    const b = new EntitlementStore(tmp(), kv);
    await b.hydrate('t1'); // explicit warm (cold-start plan correctness)
    expect(b.getPlan('t1')).toBe('pro');
    expect(b.customerId('t1')).toBe('cus_123');
  });
});

describe('TokenStore (KV-backed)', () => {
  let prevKey: string | undefined;
  beforeAll(() => {
    prevKey = process.env['GLANCE_TOKEN_KEY'];
    process.env['GLANCE_TOKEN_KEY'] = 'test-token-key';
  });
  afterAll(() => {
    if (prevKey === undefined) delete process.env['GLANCE_TOKEN_KEY'];
    else process.env['GLANCE_TOKEN_KEY'] = prevKey;
  });

  it('round-trips tokens, encrypts at rest, and hydrates on a new instance', async () => {
    const kv = new MemoryKvStore();
    const a = new TokenStore(tmp(), kv);
    a.save('t1', 'twitch', {
      accessToken: 'ACCESS-TOKEN-PLAINTEXT',
      refreshToken: 'REFRESH-TOKEN-PLAINTEXT',
      expiresAt: 123,
      scope: 'chat:read',
    });
    expect(a.load('t1', 'twitch')?.accessToken).toBe('ACCESS-TOKEN-PLAINTEXT');

    const raw = await kv.get('tok:t1:twitch');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('ACCESS-TOKEN-PLAINTEXT'); // sealed with AES-256-GCM

    const b = new TokenStore(tmp(), kv);
    expect(b.load('t1', 'twitch')).toBeNull(); // cold
    await tick();
    expect(b.load('t1', 'twitch')?.refreshToken).toBe('REFRESH-TOKEN-PLAINTEXT'); // hydrated + decrypted
  });
});

describe('KvStorage (session archives)', () => {
  const detail = (id: string, over: Partial<SessionDetail> = {}): SessionDetail => ({
    id,
    channel: 'chan',
    platform: 'twitch',
    startedAt: 1000,
    endedAt: 2000,
    durationSec: 1000,
    messages: 10,
    bits: 0,
    events: 0,
    peakChatters: 3,
    topMoment: null,
    recapHeadline: null,
    moments: [],
    timeline: [],
    recap: null,
    ...over,
  });

  it('writes through, lists newest-first, and supports prune + channel erase', () => {
    const kv = new MemoryKvStore();
    const s = new KvStorage(kv, 'sess:t1:');
    s.saveSession(detail('a', { startedAt: 100 }));
    s.saveSession(detail('b', { startedAt: 200, channel: 'other' }));

    expect(s.listSessions().map((x) => x.id)).toEqual(['b', 'a']); // newest first
    expect(s.getSession('a')?.id).toBe('a');

    expect(s.deleteByChannel('other')).toBe(1); // removes 'b'
    expect(s.getSession('b')).toBeNull();
    expect(s.pruneOlderThan(150)).toBe(1); // removes 'a' (startedAt 100)
    expect(s.listSessions()).toEqual([]);
  });

  it('hydrates an existing tenant archive from the store', async () => {
    const kv = new MemoryKvStore();
    await kv.put('sess:t1:x', JSON.stringify(detail('x')));
    const s = new KvStorage(kv, 'sess:t1:');
    await tick(); // constructor hydrate
    expect(s.getSession('x')?.id).toBe('x');
    expect(s.exportAll()).toHaveLength(1);
  });
});

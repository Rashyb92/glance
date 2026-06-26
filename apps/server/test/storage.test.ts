import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorage } from '../src/storage';
import type { SessionDetail } from '@glance/core';

function detail(id: string, startedAt: number): SessionDetail {
  return {
    id,
    channel: 'c',
    platform: 'twitch',
    startedAt,
    endedAt: startedAt + 1000,
    durationSec: 1,
    messages: 5,
    bits: 300,
    events: 1,
    peakChatters: 9,
    topMoment: { author: 'w', text: 'hi', score: 0.9 },
    recapHeadline: 'good run',
    moments: [{ id: '1', author: 'w', text: 'hi', score: 0.9, atSec: 1 }],
    timeline: [{ kind: 'donation', atSec: 1, author: 'w', bits: 300 }],
    recap: null,
  };
}

let dir: string;
let store: FileStorage;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glance-store-'));
  store = new FileStorage(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileStorage', () => {
  it('round-trips a session', () => {
    store.saveSession(detail('s1', 1000));
    const got = store.getSession('s1');
    expect(got?.bits).toBe(300);
    expect(got?.moments.length).toBe(1);
  });

  it('lists summaries (no heavy arrays), newest first', () => {
    store.saveSession(detail('s1', 1000));
    store.saveSession(detail('s2', 2000));
    const list = store.listSessions();
    expect(list.length).toBe(2);
    expect(list[0]?.id).toBe('s2');
    expect((list[0] as unknown as { moments?: unknown }).moments).toBeUndefined();
  });

  it('deletes a session', () => {
    store.saveSession(detail('s1', 1000));
    store.deleteSession('s1');
    expect(store.getSession('s1')).toBeNull();
  });

  it('returns null for a missing session and skips corrupt files', () => {
    expect(store.getSession('nope')).toBeNull();
    writeFileSync(join(dir, 'broken.json'), '{ not valid json', 'utf8');
    store.saveSession(detail('s1', 1000));
    expect(store.listSessions().length).toBe(1); // corrupt file skipped, not fatal
  });
});

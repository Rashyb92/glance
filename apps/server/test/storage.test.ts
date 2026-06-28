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

describe('FileStorage — retention, erasure, export', () => {
  it('prunes sessions older than a cutoff', () => {
    store.saveSession(detail('old', 1_000));
    store.saveSession(detail('new', 10_000));
    expect(store.pruneOlderThan(5_000)).toBe(1);
    expect(store.getSession('old')).toBeNull();
    expect(store.getSession('new')).not.toBeNull();
  });

  it('erases every session for a channel (right-to-erasure)', () => {
    store.saveSession({ ...detail('a', 1000), channel: 'alice' });
    store.saveSession({ ...detail('b', 2000), channel: 'alice' });
    store.saveSession({ ...detail('c', 3000), channel: 'bob' });
    expect(store.deleteByChannel('alice')).toBe(2);
    expect(store.listSessions().map((s) => s.id)).toEqual(['c']);
  });

  it('exports full session details, newest first', () => {
    store.saveSession(detail('s1', 1000));
    store.saveSession(detail('s2', 2000));
    const all = store.exportAll();
    expect(all.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(all[0]?.moments.length).toBe(1); // full detail, not a summary
  });

  it('scrubs a chatter by author id (DSAR), leaving others intact', () => {
    store.saveSession({
      ...detail('s1', 1000),
      moments: [
        { id: '1', author: 'whale', text: 'hi', score: 0.9, atSec: 1 },
        { id: '2', author: 'other', text: 'yo', score: 0.5, atSec: 2 },
      ],
      topMoment: { author: 'whale', text: 'hi', score: 0.9 },
    });
    expect(store.deleteByAuthor('whale')).toBe(1);
    const got = store.getSession('s1');
    expect(got?.moments.map((m) => m.author)).toEqual(['other']);
    expect(got?.topMoment).toBeNull(); // the top moment was the scrubbed chatter's
  });

  it('erases every archive (account / data deletion)', () => {
    store.saveSession(detail('s1', 1000));
    store.saveSession(detail('s2', 2000));
    expect(store.eraseAll()).toBe(2);
    expect(store.listSessions()).toEqual([]);
  });
});

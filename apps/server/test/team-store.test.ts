import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeamStore } from '../src/team-store';

let dir: string;
let store: TeamStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glance-team-'));
  store = new TeamStore(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TeamStore', () => {
  it('invites a member (normalizing the email) and lists them', () => {
    const m = store.invite('acme', ' A@Example.com ', 'member', 5);
    expect('error' in m).toBe(false);
    const list = store.list('acme');
    expect(list.length).toBe(1);
    expect(list[0]?.email).toBe('a@example.com');
    expect(list[0]?.status).toBe('invited');
  });

  it('rejects invalid emails and the owner role', () => {
    expect(store.invite('acme', 'nope', 'member', 5)).toEqual({ error: 'invalid email' });
    expect(store.invite('acme', 'a@b.co', 'owner', 5)).toEqual({ error: 'invalid role' });
  });

  it('rejects duplicates and enforces the seat limit', () => {
    store.invite('acme', 'a@b.co', 'member', 2);
    expect(store.invite('acme', 'a@b.co', 'admin', 2)).toEqual({ error: 'already a member' });
    store.invite('acme', 'b@b.co', 'member', 2);
    expect(store.invite('acme', 'c@b.co', 'member', 2)).toEqual({ error: 'seat limit reached' });
  });

  it('isolates tenants and removes by id', () => {
    const m = store.invite('acme', 'a@b.co', 'member', 5) as { id: string };
    expect(store.list('other')).toEqual([]);
    expect(store.remove('acme', m.id)).toBe(true);
    expect(store.list('acme')).toEqual([]);
    expect(store.remove('acme', 'gone')).toBe(false);
  });
});

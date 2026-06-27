import { describe, it, expect } from 'vitest';
import { MemberDenylist } from '../src/member-denylist';
import { MemoryKvStore } from '../src/kv';

const DAY = 86_400_000;

describe('MemberDenylist', () => {
  it('revokes and restores (in-memory)', () => {
    const d = new MemberDenylist();
    expect(d.isRevoked('t1', 'm1')).toBe(false);
    d.revoke('t1', 'm1');
    expect(d.isRevoked('t1', 'm1')).toBe(true);
    d.restore('t1', 'm1');
    expect(d.isRevoked('t1', 'm1')).toBe(false);
  });

  it('isolates tenants', () => {
    const d = new MemberDenylist();
    d.revoke('t1', 'm1');
    expect(d.isRevoked('t2', 'm1')).toBe(false);
  });

  it('expires entries at the token TTL (30 days)', () => {
    const d = new MemberDenylist();
    const now = 1_000_000;
    d.revoke('t1', 'm1', now);
    expect(d.isRevoked('t1', 'm1', now + 1)).toBe(true);
    expect(d.isRevoked('t1', 'm1', now + 30 * DAY + 1)).toBe(false); // token is dead anyway
  });

  it('persists a revocation and re-hydrates it on a fresh instance', async () => {
    const kv = new MemoryKvStore();
    const a = new MemberDenylist(kv);
    a.revoke('t1', 'm1');
    expect(await kv.get('deny:t1')).not.toBeNull(); // wrote through

    const b = new MemberDenylist(kv); // simulates a restart / tenant migration
    expect(b.isRevoked('t1', 'm1')).toBe(false); // cold — not yet warmed
    await b.hydrate('t1');
    expect(b.isRevoked('t1', 'm1')).toBe(true); // warmed from the durable store
  });

  it('drops already-expired entries when hydrating', async () => {
    const kv = new MemoryKvStore();
    const a = new MemberDenylist(kv);
    const old = 1000;
    a.revoke('t1', 'm1', old);
    const b = new MemberDenylist(kv);
    await b.hydrate('t1', old + 30 * DAY + 1); // hydrate "after" the entry has expired
    expect(b.isRevoked('t1', 'm1')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { SessionStore } from '../src/session-store';
import { MemoryKvStore } from '../src/kv';

const DAY = 86_400_000;

describe('SessionStore', () => {
  it('treats unknown sessions as active and revoked ones as inactive', () => {
    const s = new SessionStore();
    expect(s.isActive('t1', 's1', 1000)).toBe(true);
    s.revoke('t1', 's1');
    expect(s.isActive('t1', 's1', 1000)).toBe(false);
  });

  it('isolates tenants', () => {
    const s = new SessionStore();
    s.revoke('t1', 's1');
    expect(s.isActive('t2', 's1', 1000)).toBe(true);
  });

  it('revoke-all invalidates tokens issued before the epoch, not after', () => {
    const s = new SessionStore();
    const t = 1_000_000; // unix seconds
    s.revokeAll('t1', t);
    expect(s.isActive('t1', 'sA', t - 1)).toBe(false); // issued before "sign out everywhere"
    expect(s.isActive('t1', 'sB', t + 1)).toBe(true); // a fresh login afterward
  });

  it('forgets single-session revocations once the TTL elapses', () => {
    const s = new SessionStore();
    const now = 1_000_000_000;
    s.revoke('t1', 's1', now);
    expect(s.isActive('t1', 's1', 0, now + 1)).toBe(false);
    expect(s.isActive('t1', 's1', 0, now + 7 * DAY + 1)).toBe(true); // entry expired
  });

  it('broadcasts revocations to another instance via the control channel', () => {
    const b = new SessionStore(); // remote instance — no shared kv, no hydrate
    const a = new SessionStore(undefined, (raw) => b.applyRemote(JSON.parse(raw)));

    a.revoke('t1', 's1');
    expect(b.isActive('t1', 's1', 1000)).toBe(false); // remote saw the logout instantly

    const epoch = 2_000_000;
    a.revokeAll('t1', epoch);
    expect(b.isActive('t1', 's2', epoch - 1)).toBe(false); // remote applied the same revoke-all epoch
    expect(b.isActive('t1', 's2', epoch + 1)).toBe(true);
  });

  it('applyRemote is idempotent (safe to receive our own echo)', () => {
    const s = new SessionStore();
    s.applyRemote({ scope: 'session', tenant: 't1', id: 's1' });
    s.applyRemote({ scope: 'session', tenant: 't1', id: 's1' }); // echo
    expect(s.isActive('t1', 's1', 1000)).toBe(false);
    s.applyRemote({ scope: 'session-all', tenant: 't1', ts: 5000 });
    s.applyRemote({ scope: 'session-all', tenant: 't1', ts: 5000 }); // echo
    expect(s.isActive('t1', 's9', 4999)).toBe(false);
  });

  it('persists revocations and re-hydrates them on a fresh instance', async () => {
    const kv = new MemoryKvStore();
    const a = new SessionStore(kv);
    a.revoke('t1', 's1');
    a.revokeAll('t1', 5000);
    expect(await kv.get('session:t1')).not.toBeNull();

    const b = new SessionStore(kv); // restart / migration
    expect(b.isActive('t1', 's1', 9999)).toBe(true); // cold — not yet warmed
    await b.hydrate('t1');
    expect(b.isActive('t1', 's1', 9999)).toBe(false); // logged-out session restored
    expect(b.isActive('t1', 's2', 4999)).toBe(false); // epoch restored (issued before 5000)
    expect(b.isActive('t1', 's2', 6000)).toBe(true); // issued after the epoch
  });
});

import { describe, it, expect } from 'vitest';
import { OAuthStateStore } from '../src/integrations/routes';
import { MemoryKvStore } from '../src/kv';

describe('OAuthStateStore', () => {
  it('round-trips state once (one-time use)', async () => {
    const s = new OAuthStateStore();
    await s.put('abc', 'acme', 'verifier-1');
    expect(await s.take('abc')).toEqual({ tenant: 'acme', verifier: 'verifier-1' });
    expect(await s.take('abc')).toBeNull(); // consumed
  });

  it('returns null for unknown or expired state', async () => {
    const s = new OAuthStateStore(1000);
    expect(await s.take('nope')).toBeNull();
    await s.put('k', 'acme', undefined, 0); // stored at t=0, ttl 1000ms
    expect(await s.take('k', 2000)).toBeNull(); // expired by t=2000
  });

  it('persists to the KV store so a callback can complete on another instance', async () => {
    const kv = new MemoryKvStore();
    const a = new OAuthStateStore(600_000, kv);
    await a.put('s1', 'acme', 'v1');
    const b = new OAuthStateStore(600_000, kv); // a different instance, same store
    expect(await b.take('s1')).toEqual({ tenant: 'acme', verifier: 'v1' });
    expect(await b.take('s1')).toBeNull(); // one-time use holds across instances
  });
});

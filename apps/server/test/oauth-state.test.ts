import { describe, it, expect } from 'vitest';
import { OAuthStateStore } from '../src/integrations/routes';

describe('OAuthStateStore', () => {
  it('round-trips state once (one-time use)', () => {
    const s = new OAuthStateStore();
    s.put('abc', 'acme', 'verifier-1');
    expect(s.take('abc')).toEqual({ tenant: 'acme', verifier: 'verifier-1' });
    expect(s.take('abc')).toBeNull(); // consumed
  });

  it('returns null for unknown or expired state', () => {
    const s = new OAuthStateStore(1000);
    expect(s.take('nope')).toBeNull();
    s.put('k', 'acme', undefined, 0); // stored at t=0, ttl 1000ms
    expect(s.take('k', 2000)).toBeNull(); // expired by t=2000
  });
});

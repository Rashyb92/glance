import { describe, it, expect } from 'vitest';
import { PairingStore } from '../src/pairing-store';
import { MemoryKvStore } from '../src/kv';

describe('PairingStore', () => {
  it('issues a code consumable exactly once, across instances', async () => {
    const kv = new MemoryKvStore();
    const a = new PairingStore(kv);
    const code = await a.issue('tenantA');

    const b = new PairingStore(kv); // the device may hit a different instance than the dashboard
    expect(await b.consume(code)).toBe('tenantA');
    expect(await b.consume(code)).toBeNull(); // single-use
  });

  it('rejects unknown and expired codes', async () => {
    const s = new PairingStore(undefined, 1000); // in-memory, 1s TTL
    expect(await s.consume('nope')).toBeNull();
    const code = await s.issue('t', 0); // issued at t=0
    expect(await s.consume(code, 2000)).toBeNull(); // expired by t=2000
  });
});

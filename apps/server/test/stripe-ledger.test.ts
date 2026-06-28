import { describe, it, expect } from 'vitest';
import { StripeEventLedger } from '../src/integrations/stripe-webhook';
import { MemoryKvStore } from '../src/kv';

describe('StripeEventLedger', () => {
  it('applies an event once and drops duplicate deliveries (by event id)', async () => {
    const ledger = new StripeEventLedger(new MemoryKvStore());
    expect(await ledger.shouldApply('evt_1', 't', 1000)).toBe(true);
    expect(await ledger.shouldApply('evt_1', 't', 1000)).toBe(false); // Stripe retry → dropped
  });

  it('drops out-of-order (older) events but applies newer ones', async () => {
    const ledger = new StripeEventLedger(new MemoryKvStore());
    expect(await ledger.shouldApply('evt_new', 't', 2000)).toBe(true);
    expect(await ledger.shouldApply('evt_old', 't', 1000)).toBe(false); // older create time → stale
    expect(await ledger.shouldApply('evt_newer', 't', 3000)).toBe(true);
  });

  it('holds dedup across instances and is tenant-scoped', async () => {
    const kv = new MemoryKvStore();
    const a = new StripeEventLedger(kv);
    expect(await a.shouldApply('evt_x', 't1', 1000)).toBe(true);
    const b = new StripeEventLedger(kv); // a different worker
    expect(await b.shouldApply('evt_x', 't1', 1000)).toBe(false); // dedup survives cross-instance
    expect(await b.shouldApply('evt_y', 't2', 500)).toBe(true); // another tenant is unaffected
  });

  it('applies events that have no id (best-effort)', async () => {
    const ledger = new StripeEventLedger(new MemoryKvStore());
    expect(await ledger.shouldApply(undefined, 't', 1000)).toBe(true);
  });
});

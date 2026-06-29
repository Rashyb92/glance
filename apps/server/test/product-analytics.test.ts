import { describe, it, expect } from 'vitest';
import { ProductAnalytics } from '../src/analytics/product-analytics';
import { MemoryKvStore } from '../src/kv';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe('ProductAnalytics', () => {
  it('dedupes a stage per tenant and reports distinct-tenant counts (in-memory)', async () => {
    const a = new ProductAnalytics();
    a.reach('t1', 'signup');
    a.reach('t1', 'signup'); // duplicate — ignored
    a.reach('t1', 'activated');
    a.reach('t2', 'signup');
    expect((await a.report()).funnel).toEqual({
      signup: 2,
      activated: 1,
      engaged: 0,
      subscribed: 0,
    });
  });

  it('computes stage-to-stage conversion', async () => {
    const a = new ProductAnalytics();
    for (const t of ['a', 'b', 'c', 'd']) a.reach(t, 'signup'); // 4
    for (const t of ['a', 'b']) a.reach(t, 'activated'); // 2
    a.reach('a', 'engaged'); // 1
    const { conversion } = await a.report();
    expect(conversion.activation).toBe(50); // 2 / 4
    expect(conversion.engagement).toBe(50); // 1 / 2
    expect(conversion.subscription).toBe(0); // 0 / 1
  });

  it('skips the default tenant and no-ops when disabled', async () => {
    const off = new ProductAnalytics(undefined, false);
    off.reach('t1', 'signup');
    expect((await off.report()).funnel.signup).toBe(0);

    const on = new ProductAnalytics();
    on.reach('default', 'signup'); // the local/demo tenant is excluded
    expect((await on.report()).funnel.signup).toBe(0);
  });

  it('persists per-tenant stages; a fresh instance reports them via the durable scan', async () => {
    const kv = new MemoryKvStore();
    const a = new ProductAnalytics(kv);
    a.reach('t1', 'signup');
    a.reach('t1', 'activated');
    a.reach('t2', 'signup');
    await settle(); // let the async read-merge-write persists land

    const b = new ProductAnalytics(kv); // fresh instance (restart / another worker)
    const { funnel } = await b.report(); // derived from the durable records, not memory
    expect(funnel.signup).toBe(2);
    expect(funnel.activated).toBe(1);
  });

  it('hydrate keeps a stage deduped across a restart (no double count)', async () => {
    const kv = new MemoryKvStore();
    const a = new ProductAnalytics(kv);
    a.reach('t1', 'engaged');
    await settle();

    const b = new ProductAnalytics(kv);
    await b.hydrate('t1');
    b.reach('t1', 'engaged'); // already known → no-op
    expect((await b.report()).funnel.engaged).toBe(1);
  });
});

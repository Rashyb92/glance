import { describe, it, expect } from 'vitest';
import { AuditLog } from '../src/admin/audit-log';
import { MemoryKvStore } from '../src/kv';

describe('AuditLog', () => {
  it('records most-recent-first and filters by tenant + limit', async () => {
    const log = new AuditLog(new MemoryKvStore());
    await log.record({ ts: 1, operator: 'alice', action: 'view-tenant', tenant: 't1' });
    await log.record({ ts: 2, operator: 'bob', action: 'force-logout', tenant: 't2' });
    await log.record({ ts: 3, operator: 'alice', action: 'erase-tenant-data', tenant: 't1' });

    expect((await log.list()).map((e) => e.ts)).toEqual([3, 2, 1]); // newest first
    expect((await log.list({ tenant: 't1' })).map((e) => e.action)).toEqual([
      'erase-tenant-data',
      'view-tenant',
    ]);
    expect(await log.list({ limit: 1 })).toHaveLength(1);
  });

  it('works without a KvStore (logger-only) and lists nothing', async () => {
    const log = new AuditLog();
    await expect(log.record({ ts: 1, operator: 'a', action: 'x' })).resolves.toBeUndefined();
    expect(await log.list()).toEqual([]);
  });

  it('caps the durable ring buffer at 2000, keeping the newest', async () => {
    const log = new AuditLog(new MemoryKvStore());
    for (let i = 0; i < 2050; i++) await log.record({ ts: i, operator: 'a', action: 'x' });
    const all = await log.list({ limit: 5000 });
    expect(all.length).toBe(2000);
    expect(all[0]?.ts).toBe(2049); // newest retained
    expect(all.at(-1)?.ts).toBe(50); // oldest 50 evicted
  });
});

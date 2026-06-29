import { describe, it, expect } from 'vitest';
import { MemoryKvStore, PgKvStore } from '../src/kv';
import type { SqlClient, SqlResult } from '../src/sql';

// A fake SqlClient that interprets PgKvStore's four queries against an in-memory map,
// so the store is exercised end-to-end without a real database.
function fakeSql(): SqlClient {
  const map = new Map<string, string>();
  const query = (text: string, params: unknown[] = []): Promise<SqlResult> => {
    const p = params as string[];
    let rows: Record<string, unknown>[] = [];
    if (text.startsWith('SELECT value')) {
      const v = map.get(p[0] ?? '');
      rows = v != null ? [{ value: v }] : [];
    } else if (text.startsWith('INSERT')) {
      map.set(p[0] ?? '', p[1] ?? '');
    } else if (text.startsWith('DELETE')) {
      map.delete(p[0] ?? '');
    } else if (text.startsWith('SELECT key')) {
      const prefix = (p[0] ?? '').slice(0, -1); // strip trailing %
      rows = [...map].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    }
    return Promise.resolve({ rows });
  };
  return { query: query as SqlClient['query'] };
}

describe.each([
  ['MemoryKvStore', (): MemoryKvStore | PgKvStore => new MemoryKvStore()],
  ['PgKvStore', (): MemoryKvStore | PgKvStore => new PgKvStore(fakeSql())],
])('%s', (_name, make) => {
  it('puts, gets, lists by prefix, and deletes', async () => {
    const kv = make();
    expect(await kv.get('settings:acme')).toBeNull();

    await kv.put('settings:acme', '{"threshold":0.5}');
    await kv.put('settings:bob', '{"threshold":0.7}');
    await kv.put('team:acme', '[]');

    expect(await kv.get('settings:acme')).toBe('{"threshold":0.5}');

    const settings = await kv.list('settings:');
    expect(settings.map((r) => r.key).sort()).toEqual(['settings:acme', 'settings:bob']);

    await kv.delete('settings:acme');
    expect(await kv.get('settings:acme')).toBeNull();
    expect((await kv.list('settings:')).length).toBe(1);
  });
});

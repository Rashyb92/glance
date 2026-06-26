import type { SqlClient } from './sql';

/**
 * A namespaced key-value store. Every per-tenant store (settings, OAuth tokens, teams,
 * entitlements, push devices) is "one JSON blob per key", so they all map onto this one
 * abstraction — `MemoryKvStore` for dev/tests, `PgKvStore` for durable multi-instance.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; value: string }>>;
}

export class MemoryKvStore implements KvStore {
  private readonly map = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }
  put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
  list(prefix: string): Promise<Array<{ key: string; value: string }>> {
    const out: Array<{ key: string; value: string }> = [];
    for (const [key, value] of this.map) if (key.startsWith(prefix)) out.push({ key, value });
    return Promise.resolve(out);
  }
}

/**
 * Postgres KV over a single table: `glance_kv (key text primary key, value text)`.
 * The table name is a fixed config constant (never user input); all values are passed
 * as bound parameters.
 */
export class PgKvStore implements KvStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly table = 'glance_kv',
  ) {}

  async get(key: string): Promise<string | null> {
    const r = await this.sql.query<{ value: string }>(
      `SELECT value FROM ${this.table} WHERE key = $1`,
      [key],
    );
    return r.rows[0]?.value ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO ${this.table} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value],
    );
  }

  async delete(key: string): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.table} WHERE key = $1`, [key]);
  }

  async list(prefix: string): Promise<Array<{ key: string; value: string }>> {
    const r = await this.sql.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${this.table} WHERE key LIKE $1`,
      [`${prefix}%`],
    );
    return r.rows;
  }
}

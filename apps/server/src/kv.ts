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
  /** Optional one-time setup (e.g. create the backing table). */
  init?(): Promise<void>;
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

  /** Create the backing table if absent — run once on boot so DB setup isn't a manual step. */
  async init(): Promise<void> {
    await this.sql.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
  }

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
    // Escape LIKE metacharacters so a prefix containing `_` or `%` can't widen the match
    // into another tenant's keys. Tenant ids are sanitized to [A-Za-z0-9_-], but `_` is a
    // single-char LIKE wildcard, so `sess:team_a:` would otherwise also match `sess:teamXa:`.
    const escaped = prefix.replace(/([\\%_])/g, '\\$1');
    const r = await this.sql.query<{ key: string; value: string }>(
      `SELECT key, value FROM ${this.table} WHERE key LIKE $1 ESCAPE '\\'`,
      [`${escaped}%`],
    );
    return r.rows;
  }
}

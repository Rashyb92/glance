import { createRequire } from 'node:module';
import type { SqlClient, SqlResult } from './sql';

/**
 * A {@link SqlClient} backed by node-postgres (`pg`).
 *
 * `pg` is an OPTIONAL runtime dependency: it's loaded via `createRequire` so the whole
 * codebase typechecks and runs without it (the file-backed stores need no database). To
 * use Postgres-backed stores in production, `pnpm add pg` and set `DATABASE_URL`. If the
 * module is missing, `createRequire(...)('pg')` throws and the caller falls back to files.
 */
interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function createPgClient(connectionString: string): SqlClient {
  const load = createRequire(import.meta.url);
  const pg = load('pg') as { Pool: new (config: { connectionString: string }) => PgPoolLike };
  const pool = new pg.Pool({ connectionString });
  return {
    async query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<R>> {
      const result = await pool.query(text, params);
      return { rows: result.rows as R[] };
    },
  };
}

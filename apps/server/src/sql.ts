/**
 * Minimal SQL surface Glance needs, matching node-postgres (`pg`)'s `query`. Defining
 * our own interface keeps the dependency optional: the file-backed stores need no
 * database, and a deployment wires a real `pg` Pool behind this interface (see
 * docs/SCALE.md). Always use parameterized queries ($1, $2, …).
 */
export interface SqlResult<R = Record<string, unknown>> {
  rows: R[];
}

export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlResult<R>>;
}

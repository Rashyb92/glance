/**
 * A capacity-bounded pool of upstream connections (one per tenant/channel), held by a
 * single worker. It refuses new connections past `capacity` so a worker can't be
 * overloaded; the orchestrator shards tenants (see sharding.ts) so each worker stays
 * within budget. Generic + unit-tested.
 */
export class ConnectionPool<T> {
  private readonly conns = new Map<string, T>();

  constructor(private readonly capacity: number) {}

  /** Return the existing connection for `key`, or create one if under capacity (else null). */
  ensure(key: string, factory: () => T): T | null {
    const existing = this.conns.get(key);
    if (existing !== undefined) return existing;
    if (this.conns.size >= this.capacity) return null;
    const conn = factory();
    this.conns.set(key, conn);
    return conn;
  }

  release(key: string, onRelease?: (conn: T) => void): void {
    const conn = this.conns.get(key);
    if (conn === undefined) return;
    onRelease?.(conn);
    this.conns.delete(key);
  }

  has(key: string): boolean {
    return this.conns.has(key);
  }
  size(): number {
    return this.conns.size;
  }
  atCapacity(): boolean {
    return this.conns.size >= this.capacity;
  }
}

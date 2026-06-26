/**
 * The minimal Redis surface Glance needs, matching node-redis v4's shape. Defining our
 * own interface — instead of importing `redis` — keeps the dependency optional: the
 * in-process defaults need no Redis, and a multi-instance deployment wires a real client
 * behind these interfaces (see docs/SCALE.md). A subscribed connection can't publish, so
 * pub/sub uses two clients.
 */
export interface RedisPubSub {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string, listener: (message: string) => void): unknown;
}

export interface RedisCounters {
  incr(key: string): Promise<number>;
  pExpire(key: string, ms: number): Promise<unknown>;
}

import { createRequire } from 'node:module';
import type { RedisCounters, RedisPubSub } from './redis';
import { logger } from './logger';

/**
 * Concrete Redis clients (pub/sub + counters) for multi-instance mode, built from a
 * connection URL using node-redis (`redis`) loaded as an OPTIONAL dependency via
 * createRequire — so the codebase typechecks and runs without it. `pnpm add redis` to
 * enable. Connection happens in the background; every operation is gated on readiness and
 * fails soft, so a Redis hiccup never crashes the pipeline.
 */
interface NodeRedisClient {
  connect(): Promise<unknown>;
  duplicate(): NodeRedisClient;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  incr(key: string): Promise<number>;
  pExpire(key: string, ms: number): Promise<unknown>;
  on(event: string, cb: (err: unknown) => void): unknown;
}

export interface RedisClients {
  publisher: RedisPubSub;
  subscriber: RedisPubSub;
  counters: RedisCounters;
}

export function createRedisClients(url: string): RedisClients {
  const lib = createRequire(import.meta.url)('redis') as {
    createClient: (opts: { url: string }) => NodeRedisClient;
  };
  const base = lib.createClient({ url });
  const sub = base.duplicate();
  base.on('error', (e) => logger.warn('redis error', { error: String(e) }));
  sub.on('error', (e) => logger.warn('redis subscriber error', { error: String(e) }));
  const ready = Promise.all([base.connect(), sub.connect()]).then(
    () => logger.info('redis connected (multi-instance bus + usage meter)'),
    (e) => logger.error('redis connect failed — staying in-process', { error: String(e) }),
  );

  const publisher: RedisPubSub = {
    publish: (ch, msg) => void ready.then(() => base.publish(ch, msg)).catch(() => undefined),
    subscribe: (ch, l) => void ready.then(() => base.subscribe(ch, l)).catch(() => undefined),
  };
  const subscriber: RedisPubSub = {
    publish: () => undefined,
    subscribe: (ch, l) => void ready.then(() => sub.subscribe(ch, l)).catch(() => undefined),
  };
  const counters: RedisCounters = {
    incr: async (key) => {
      await ready;
      return base.incr(key);
    },
    pExpire: async (key, ms) => {
      await ready;
      return base.pExpire(key, ms);
    },
  };
  return { publisher, subscriber, counters };
}

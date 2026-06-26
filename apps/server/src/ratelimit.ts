import type { RedisCounters } from './redis';

/**
 * Token-bucket rate limiter keyed by an arbitrary string (here: client IP).
 * In-process and dependency-free; for multi-instance deployments this moves behind
 * the shared Bus/Redis so limits are enforced fleet-wide. Pure and unit-tested.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}

  /** Consume `cost` tokens for `key`; returns false (deny) if the bucket is dry. */
  allow(key: string, cost = 1, now = Date.now()): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    const elapsedSec = Math.max(0, (now - bucket.updated) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.updated = now;

    let allowed = false;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      allowed = true;
    }
    this.buckets.set(key, bucket);
    return allowed;
  }

  /** Drop idle buckets so the map can't grow unbounded under churning IPs. */
  sweep(maxIdleMs = 600_000, now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated > maxIdleMs) this.buckets.delete(key);
    }
  }

  /** Number of tracked keys (for metrics/tests). */
  size(): number {
    return this.buckets.size;
  }
}

/**
 * Redis-backed fixed-window rate limiter — the multi-instance counterpart of
 * {@link RateLimiter}. INCR on a per-key, per-window bucket (with a TTL) enforces the
 * limit across all gateway instances. Async (a Redis round-trip), so wire it where the
 * caller can await.
 */
export class RedisRateLimiter {
  constructor(
    private readonly redis: RedisCounters,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly prefix = 'glance:rl',
  ) {}

  async allow(key: string, now: number = Date.now()): Promise<boolean> {
    if (this.limit <= 0) return false;
    const window = Math.floor(now / this.windowMs);
    const bucket = `${this.prefix}:${key}:${window}`;
    const n = await this.redis.incr(bucket);
    if (n === 1) await this.redis.pExpire(bucket, this.windowMs);
    return n <= this.limit;
  }
}

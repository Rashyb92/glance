import type { RedisCounters } from './redis';

/**
 * A daily AI-usage meter — in-memory ({@link AiUsageMeter}) or Redis-backed
 * ({@link RedisUsageMeter}). Async-tolerant so either implementation backs the same
 * call site (`canUseAi`).
 */
export interface UsageMeter {
  tryConsume(tenant: string, cap: number, now?: Date): boolean | Promise<boolean>;
  /** Units consumed today, for the admin snapshot / metrics. Optional: a backend that can't read
   *  without consuming (e.g. the Redis meter) omits it, and callers treat absence as "unknown". */
  used?(tenant: string, now?: Date): number | Promise<number>;
}

/**
 * Per-tenant daily AI-call meter — the enforcement behind a plan's `aiCallsPerDay`
 * cap. Each AI call (summary, priority re-rank, recap) consumes one unit; once the
 * day's budget is spent, AI calls are skipped until the next UTC day and the
 * pipeline falls back to its deterministic output. In-process and pure (inject
 * `now` in tests); back it with the shared store for multi-instance deployments.
 */
export class AiUsageMeter {
  private day = '';
  private readonly counts = new Map<string, number>();

  /** Consume one unit for `tenant` against `cap`. Returns false when the cap is hit. */
  tryConsume(tenant: string, cap: number, now: Date = new Date()): boolean {
    if (cap <= 0) return false;
    this.rollOver(now);
    const used = this.counts.get(tenant) ?? 0;
    if (used >= cap) return false;
    this.counts.set(tenant, used + 1);
    return true;
  }

  /** Units consumed by `tenant` today (for metrics / "x of y used" UI). */
  used(tenant: string, now: Date = new Date()): number {
    this.rollOver(now);
    return this.counts.get(tenant) ?? 0;
  }

  private rollOver(now: Date): void {
    const day = now.toISOString().slice(0, 10); // UTC date
    if (day !== this.day) {
      this.day = day;
      this.counts.clear();
    }
  }
}

/**
 * Redis-backed daily AI-usage meter — the multi-instance counterpart of {@link AiUsageMeter}.
 * An atomic INCR on a per-tenant, per-day key (with a TTL) enforces the cap fleet-wide,
 * regardless of which worker serves the tenant.
 */
export class RedisUsageMeter {
  /** Per-instance fallback used when Redis is unreachable, so an AI call degrades to
   *  per-instance limiting rather than failing outright. */
  private readonly fallback = new AiUsageMeter();

  constructor(
    private readonly redis: RedisCounters,
    private readonly prefix = 'glance:ai',
  ) {}

  async tryConsume(tenant: string, cap: number, now: Date = new Date()): Promise<boolean> {
    if (cap <= 0) return false;
    const day = now.toISOString().slice(0, 10);
    const key = `${this.prefix}:${tenant}:${day}`;
    try {
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.pExpire(key, 36 * 60 * 60 * 1000); // ~1.5 days (TZ-safe)
      return n <= cap;
    } catch {
      // Redis down — fall back to per-instance limiting instead of blocking AI fleet-wide.
      return this.fallback.tryConsume(tenant, cap, now);
    }
  }
}

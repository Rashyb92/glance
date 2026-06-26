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

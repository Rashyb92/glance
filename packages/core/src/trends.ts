/**
 * Sliding-window trend detector. Counts how often the same normalized message
 * recurs within a time window — the "chat is all saying the same thing" signal
 * that powers the `trend` salience category.
 */
export class TrendTracker {
  private readonly window: Array<{ norm: string; t: number }> = [];

  constructor(private readonly windowMs: number = 12_000) {}

  /** Record a message and return how many times its normalized form is in the window. */
  record(text: string, now: number = Date.now()): number {
    this.evict(now);
    const norm = normalizeTrendText(text);
    this.window.push({ norm, t: now });
    if (norm.length === 0) return 0;
    let count = 0;
    for (const e of this.window) {
      if (e.norm === norm) count++;
    }
    return count;
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.window.length > 0 && this.window[0]!.t < cutoff) {
      this.window.shift();
    }
  }
}

/** Collapse a message to a comparable form: lowercase, alphanumerics + spaces only. */
export function normalizeTrendText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

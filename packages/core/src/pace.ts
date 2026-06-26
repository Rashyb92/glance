/**
 * @glance/core — chat pacing.
 *
 * How fast the live feed flows to the creator, independent of salience (which is
 * about importance, not rate). `live` is real-time: every message that clears the
 * engine reaches the overlay/earbuds instantly. `balanced` and `calm` cap the live
 * feed to a sustainable messages-per-minute so a firehose chat stays readable.
 *
 * Crucially, throttled messages still count toward stats and the AI summary — the
 * slower modes *defer* noise to the periodic digest rather than dropping it, so
 * nothing is lost. The biggest moments (high salience, donations, raids) always
 * pass regardless of pace, because you never want to miss those.
 */
export type ChatPace = 'live' | 'balanced' | 'calm';

/** Live-feed cap in messages/minute per pace. 0 = uncapped (real-time). */
export const PACE_PER_MIN: Record<ChatPace, number> = {
  live: 0,
  balanced: 20,
  calm: 8,
};

/** Messages at/above this salience always surface, regardless of pace. */
export const PACE_BYPASS_SCORE = 0.85;

export function isChatPace(value: unknown): value is ChatPace {
  return value === 'live' || value === 'balanced' || value === 'calm';
}

/**
 * Sliding-window rate limiter for the live message feed. Deterministic and pure
 * (the caller supplies `now`), so it unit-tests cleanly. High-salience messages
 * bypass the cap and don't consume budget, so the biggest moments always show and
 * a steady trickle of ordinary chat flows beneath them.
 */
export class PaceGate {
  private times: number[] = [];

  constructor(private pace: ChatPace = 'live') {}

  setPace(pace: ChatPace): void {
    this.pace = pace;
  }

  /** Whether a scored message should reach the live feed at `now`. */
  allow(score: number, now: number): boolean {
    const cap = PACE_PER_MIN[this.pace];
    if (cap <= 0) return true; // live — uncapped
    if (score >= PACE_BYPASS_SCORE) return true; // never throttle the biggest moments
    const cutoff = now - 60_000;
    while (this.times.length > 0 && (this.times[0] ?? 0) < cutoff) this.times.shift();
    if (this.times.length >= cap) return false;
    this.times.push(now);
    return true;
  }
}

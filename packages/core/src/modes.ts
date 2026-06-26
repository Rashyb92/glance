import type { InteractionMode, ScoredMessage } from './types';

/** Default salience cut-off for Hybrid mode. Messages at/above this break through. */
export const DEFAULT_SURFACE_THRESHOLD = 0.5;

export interface ModePolicy {
  mode: InteractionMode;
  surfaceThreshold: number;
}

export function makePolicy(
  mode: InteractionMode,
  surfaceThreshold: number = DEFAULT_SURFACE_THRESHOLD,
): ModePolicy {
  return { mode, surfaceThreshold };
}

/**
 * Should the HUD surface this individual message prominently?
 *
 * - `raw`    — everything flows; the HUD itself paces it for readability.
 * - `assist` — individual messages are hidden; only AI summaries appear.
 * - `hybrid` — only messages at/above the salience threshold break through.
 */
export function shouldSurface(scored: ScoredMessage, policy: ModePolicy): boolean {
  switch (policy.mode) {
    case 'raw':
      return true;
    case 'assist':
      return false;
    case 'hybrid':
      return scored.score >= policy.surfaceThreshold;
    default:
      return false;
  }
}

import { hapticPattern, type SalienceCategory } from '@glance/core';

/**
 * Device haptics for the HUD — the "feel it" arm of the routing matrix. A distinct
 * vibration rhythm per category lets the creator feel what arrived without looking or
 * hearing it. Best-effort: silently no-ops where the Web Vibration API is unavailable
 * (desktop browsers, iOS Safari). On iOS, the native shell can pair the Capacitor Haptics
 * plugin for the same effect.
 */
export function haptic(category: SalienceCategory): void {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    navigator.vibrate(hapticPattern(category));
  } catch {
    /* vibration unavailable on this device */
  }
}

import { hapticPattern, type SalienceCategory } from '@glance/core';

/**
 * Device haptics for the phone companion — the "feel it" arm of the routing matrix.
 * A distinct vibration rhythm per category lets the creator feel a donation / question /
 * mod alert in their pocket without looking or hearing it, independent of the sound
 * toggle. Best-effort: silently no-ops where the Web Vibration API is unavailable
 * (notably iOS Safari; on iOS the native shell can add the Capacitor Haptics plugin).
 */
export function haptic(category: SalienceCategory): void {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    navigator.vibrate(hapticPattern(category));
  } catch {
    /* vibration unavailable on this device */
  }
}

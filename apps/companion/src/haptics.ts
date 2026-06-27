import { hapticPattern, nativeHaptic, type SalienceCategory } from '@glance/core';

/**
 * Device haptics for the phone companion — the "feel it" arm of the routing matrix.
 * A distinct feedback per category lets the creator feel a donation / question / mod alert
 * in their pocket without looking or hearing it, independent of the sound toggle.
 *
 * Two delivery paths, picked at runtime:
 *  - Native shell (Capacitor iOS/Android with @capacitor/haptics): semantic impacts /
 *    notification feedback via the Capacitor bridge — this is what makes haptics work on iOS,
 *    where the Web Vibration API is unavailable.
 *  - Plain browser (home-screen PWA / Android TWA): the Web Vibration API with per-category
 *    patterns.
 * Best-effort: silently no-ops where neither is available. No static @capacitor/haptics import,
 * so the web bundle has no extra dependency — the native build supplies the bridge.
 */
interface CapacitorHapticsBridge {
  impact(options: { style: string }): unknown;
  notification(options: { type: string }): unknown;
}
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { Haptics?: CapacitorHapticsBridge };
}

function capacitorHaptics(): CapacitorHapticsBridge | null {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.Haptics) return cap.Plugins.Haptics;
  return null;
}

export function haptic(category: SalienceCategory): void {
  try {
    const native = capacitorHaptics();
    if (native) {
      const spec = nativeHaptic(category);
      if (spec.kind === 'impact') native.impact({ style: spec.style });
      else native.notification({ type: spec.type });
      return;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(hapticPattern(category));
    }
  } catch {
    /* haptics unavailable on this device */
  }
}

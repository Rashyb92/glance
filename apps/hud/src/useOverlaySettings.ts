import { useCallback, useEffect, useState } from 'react';

/** Device-local presentation preferences for the overlay. Persisted per browser
 *  in localStorage — these are a "how it looks here" concern, distinct from the
 *  server-owned engine settings ("what gets surfaced"). */
export interface OverlaySettings {
  placement: 'left' | 'right';
  scale: number; // 0.85..1.2
  opacity: number; // 0.5..1
  density: 'compact' | 'cozy' | 'roomy';
  motion: boolean;
}

const STORAGE_KEY = 'glance.overlay.v1';

const DEFAULTS: OverlaySettings = {
  placement: 'right',
  scale: 1,
  opacity: 1,
  density: 'cozy',
  motion: true,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function normalize(input: unknown): OverlaySettings {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    placement: o['placement'] === 'left' ? 'left' : 'right',
    scale: clamp(typeof o['scale'] === 'number' ? o['scale'] : 1, 0.85, 1.2),
    opacity: clamp(typeof o['opacity'] === 'number' ? o['opacity'] : 1, 0.5, 1),
    density:
      o['density'] === 'compact' || o['density'] === 'roomy'
        ? (o['density'] as OverlaySettings['density'])
        : 'cozy',
    motion: o['motion'] !== false,
  };
}

function load(): OverlaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function useOverlaySettings(): [OverlaySettings, (patch: Partial<OverlaySettings>) => void] {
  const [settings, setSettings] = useState<OverlaySettings>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* storage unavailable (private mode) — settings simply won't persist */
    }
  }, [settings]);

  const update = useCallback((patch: Partial<OverlaySettings>) => {
    setSettings((prev) => normalize({ ...prev, ...patch }));
  }, []);

  return [settings, update];
}

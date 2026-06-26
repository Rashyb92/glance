import { useEffect, useState } from 'react';

/**
 * Device battery for the HUD. In a browser (dev) this reads the Web Battery Status
 * API where available; on smart glasses the device runtime can expose the same shape
 * via `navigator.getBattery`, so the HUD shows the *glasses'* battery with no change.
 * Returns `{ level: null }` when no battery source is available.
 */
export interface BatteryState {
  level: number | null; // 0..1
  charging: boolean;
}

interface BatteryLike {
  level: number;
  charging: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export function useBattery(): BatteryState {
  const [state, setState] = useState<BatteryState>({ level: null, charging: false });

  useEffect(() => {
    const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryLike> })
      .getBattery;
    if (typeof getBattery !== 'function') return;

    let battery: BatteryLike | null = null;
    let alive = true;
    const update = (): void => {
      if (battery) setState({ level: battery.level, charging: battery.charging });
    };

    void getBattery.call(navigator).then((b) => {
      if (!alive) return;
      battery = b;
      update();
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
    });

    return () => {
      alive = false;
      if (battery) {
        battery.removeEventListener('levelchange', update);
        battery.removeEventListener('chargingchange', update);
      }
    };
  }, []);

  return state;
}

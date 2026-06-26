import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_ENGINE_SETTINGS, normalizeEngineSettings } from '@glance/core';
import type { EngineSettings } from '@glance/core';

/** Persistence seam for engine settings. Swapped for a DB-backed store in M3. */
export interface SettingsStore {
  load(): EngineSettings;
  save(settings: EngineSettings): void;
}

/** JSON-file store with atomic writes (write-temp-then-rename) and safe fallback. */
export class FileSettingsStore implements SettingsStore {
  constructor(private readonly file: string) {}

  load(): EngineSettings {
    try {
      return normalizeEngineSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_ENGINE_SETTINGS };
    }
  }

  save(settings: EngineSettings): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }
}

export type SettingsListener = (settings: EngineSettings) => void;

/**
 * Holds the live engine settings, persists changes, and notifies a listener so
 * the running session and all clients stay in sync. All mutations pass through
 * `normalizeEngineSettings`, so `get()` always returns a valid object.
 */
export class SettingsService {
  private current: EngineSettings;

  constructor(
    private readonly store: SettingsStore,
    private readonly onChange: SettingsListener,
  ) {
    this.current = store.load();
  }

  get(): EngineSettings {
    return this.current;
  }

  update(patch: unknown): EngineSettings {
    const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
    // Start from current, then apply ONLY known keys present in the patch — never
    // spread raw client input. normalizeEngineSettings then validates + clamps.
    const merged: Record<string, unknown> = { ...this.current };
    const keys: (keyof EngineSettings)[] = [
      'surfaceThreshold',
      'keywords',
      'summaryIntervalMs',
      'routing',
      'aiSummaries',
      'aiPriorities',
      'moderation',
      'moderationSensitivity',
      'retentionDays',
      'storeMessageText',
      'branding',
    ];
    for (const key of keys) {
      if (key in p) merged[key] = p[key];
    }
    this.current = normalizeEngineSettings(merged);
    this.store.save(this.current);
    this.onChange(this.current);
    return this.current;
  }
}

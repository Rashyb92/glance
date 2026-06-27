import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_ENGINE_SETTINGS, normalizeEngineSettings } from '@glance/core';
import type { EngineSettings } from '@glance/core';
import type { KvStore } from './kv';

/** Persistence seam for engine settings. File-backed for dev; KV/Postgres at scale. */
export interface SettingsStore {
  load(): EngineSettings;
  save(settings: EngineSettings): void;
  /** Optional async warm-up from a durable backing store (e.g. Postgres). */
  hydrate?(): Promise<EngineSettings | null>;
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

/**
 * KV-backed settings with a synchronous write-through cache. `load()` returns the
 * cached value (defaults until {@link hydrate} completes); `save()` updates the cache
 * and writes through to the KV store. Backed by `MemoryKvStore` in tests and `PgKvStore`
 * in production, this is what points settings at Postgres for multi-instance deploys —
 * with tenant-sticky routing each tenant lives on one instance, so its cache is the
 * source of truth and the eventual-consistency window is only the first cold load.
 */
export class KvSettingsStore implements SettingsStore {
  private cache: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS };

  constructor(
    private readonly kv: KvStore,
    private readonly key: string,
  ) {}

  load(): EngineSettings {
    return this.cache;
  }

  save(settings: EngineSettings): void {
    this.cache = settings;
    void this.kv.put(this.key, JSON.stringify(settings)).catch(() => undefined);
  }

  async hydrate(): Promise<EngineSettings | null> {
    try {
      const raw = await this.kv.get(this.key);
      if (raw === null) return null;
      this.cache = normalizeEngineSettings(JSON.parse(raw));
      return this.cache;
    } catch {
      return null; // DB unreachable / corrupt → keep the cached defaults
    }
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

  /** Replace the live settings from an async backing load (Postgres warm-up) and notify. */
  rehydrate(settings: EngineSettings): void {
    this.current = settings;
    this.onChange(this.current);
  }

  update(patch: unknown): EngineSettings {
    const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
    // Start from current, then apply ONLY known keys present in the patch — never
    // spread raw client input. normalizeEngineSettings then validates + clamps.
    const merged: Record<string, unknown> = { ...this.current };
    const keys: (keyof EngineSettings)[] = [
      'surfaceThreshold',
      'pace',
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

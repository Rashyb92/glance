import { readFileSync } from 'node:fs';
import type { KvStore } from './kv';

/** Read a file as utf8, or null if it doesn't exist / can't be read (the file-store branch). */
export function readFileOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * A synchronous write-through cache over an async {@link KvStore}. Lets the file-shaped
 * stores (settings, tokens, teams, push, entitlements) keep their sync interfaces while
 * persisting to Postgres: `read` returns the cached value (and triggers a one-time
 * background hydrate from the store), `write`/`remove` update the cache and write through.
 *
 * With tenant-sticky routing each tenant lives on one instance, so its cache is the source
 * of truth and the only eventual-consistency window is the first cold read of a key.
 */
export class KvCache {
  private readonly cache = new Map<string, string>();
  private readonly hydrated = new Set<string>();

  constructor(private readonly kv: KvStore) {}

  /** Cached value (null until present/hydrated). Kicks off a one-time background hydrate. */
  read(key: string): string | null {
    if (!this.hydrated.has(key)) {
      this.hydrated.add(key);
      void this.kv
        .get(key)
        .then((value) => {
          // Don't clobber a write that happened while the fetch was in flight.
          if (value !== null && !this.cache.has(key)) this.cache.set(key, value);
        })
        .catch(() => undefined);
    }
    return this.cache.get(key) ?? null;
  }

  /**
   * Eagerly load a key from the durable store and await it — used where a cold read must be
   * correct rather than eventually-correct (e.g. a tenant's plan before its settings are
   * clamped). Safe to call alongside {@link read}: a concurrent write is never clobbered.
   */
  async hydrate(key: string): Promise<void> {
    this.hydrated.add(key);
    try {
      const value = await this.kv.get(key);
      if (value !== null && !this.cache.has(key)) this.cache.set(key, value);
    } catch {
      /* store unavailable — leave the cache as-is */
    }
  }

  write(key: string, value: string): void {
    this.cache.set(key, value);
    this.hydrated.add(key);
    void this.kv.put(key, value).catch(() => undefined);
  }

  remove(key: string): void {
    this.cache.delete(key);
    this.hydrated.add(key);
    void this.kv.delete(key).catch(() => undefined);
  }
}

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionDetail, SessionSummary } from '@glance/core';
import type { KvStore } from './kv';
import { logger } from './logger';

/** Persistence seam for archived sessions. Swap for SQLite/Postgres at scale. */
export interface Storage {
  saveSession(detail: SessionDetail): void;
  listSessions(limit?: number): SessionSummary[];
  getSession(id: string): SessionDetail | null;
  deleteSession(id: string): void;
  /** Delete archives older than `cutoffMs` (epoch ms). Returns count removed. */
  pruneOlderThan(cutoffMs: number): number;
  /** Delete every archive for a channel (right-to-erasure). Returns count removed. */
  deleteByChannel(channel: string): number;
  /** Full export of every archived session (data portability). */
  exportAll(): SessionDetail[];
}

/**
 * File-backed session archive: one JSON document per session, written atomically
 * (temp-then-rename). Reads tolerate missing/corrupt records rather than throwing.
 * One FileStorage instance is scoped to a single tenant's directory, so tenants are
 * physically isolated on disk.
 */
export class FileStorage implements Storage {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  saveSession(detail: SessionDetail): void {
    const target = this.fileFor(detail.id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(detail), 'utf8');
    renameSync(tmp, target);
  }

  getSession(id: string): SessionDetail | null {
    try {
      return JSON.parse(readFileSync(this.fileFor(id), 'utf8')) as SessionDetail;
    } catch {
      return null;
    }
  }

  deleteSession(id: string): void {
    this.remove(`${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  }

  listSessions(limit = 50): SessionSummary[] {
    const summaries = this.readAll().map((r) => toSummary(r.detail));
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries.slice(0, limit);
  }

  exportAll(): SessionDetail[] {
    const details = this.readAll().map((r) => r.detail);
    details.sort((a, b) => b.startedAt - a.startedAt);
    return details;
  }

  pruneOlderThan(cutoffMs: number): number {
    let removed = 0;
    for (const { file, detail } of this.readAll()) {
      if (detail.startedAt < cutoffMs && this.remove(file)) removed += 1;
    }
    return removed;
  }

  deleteByChannel(channel: string): number {
    let removed = 0;
    for (const { file, detail } of this.readAll()) {
      if (detail.channel === channel && this.remove(file)) removed += 1;
    }
    return removed;
  }

  private readAll(): Array<{ file: string; detail: SessionDetail }> {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Array<{ file: string; detail: SessionDetail }> = [];
    for (const file of files) {
      try {
        const detail = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as SessionDetail;
        out.push({ file, detail });
      } catch {
        /* skip a corrupt record rather than failing the whole batch */
      }
    }
    return out;
  }

  private remove(file: string): boolean {
    try {
      rmSync(join(this.dir, file));
      return true;
    } catch {
      return false;
    }
  }

  private fileFor(id: string): string {
    return join(this.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  }
}

/**
 * KV-backed session archive (Postgres for durable, multi-instance history). Cache-aside:
 * a tenant's archives are hydrated into memory once on construction and every write is
 * write-through, so the synchronous {@link Storage} interface is preserved while the data
 * lives in Postgres. A {@link SessionDetail} is small and bounded (capped moments; a
 * timeline of events/donations/markers, not every message), so resident caching of a
 * tenant's archives stays within a few MB even at the retention cap.
 *
 * One instance is scoped to a single tenant via `prefix` (e.g. `sess:<tenant>:`). Resident
 * (and persisted) archives are capped per tenant ({@link MAX_RESIDENT_SESSIONS}) on top of
 * age-based retention, so memory + storage stay bounded even for a high-volume tenant.
 */
const MAX_RESIDENT_SESSIONS = 1000;

export class KvStorage implements Storage {
  private readonly cache = new Map<string, SessionDetail>();

  constructor(
    private readonly kv: KvStore,
    private readonly prefix: string,
  ) {
    void this.hydrate();
  }

  /** Load this tenant's archives into memory once, on construction. */
  private async hydrate(): Promise<void> {
    try {
      for (const row of await this.kv.list(this.prefix)) {
        try {
          const detail = JSON.parse(row.value) as SessionDetail;
          // Don't clobber a write that landed while the list() was in flight.
          if (!this.cache.has(detail.id)) this.cache.set(detail.id, detail);
        } catch {
          /* skip a corrupt record rather than failing the whole hydrate */
        }
      }
    } catch {
      /* store unavailable — start empty; write-through still persists new archives */
    }
  }

  saveSession(detail: SessionDetail): void {
    this.cache.set(detail.id, detail);
    void this.kv
      .put(this.keyFor(detail.id), JSON.stringify(detail))
      .catch((err) =>
        logger.error('session write-through failed', { id: detail.id, error: String(err) }),
      );
    if (this.cache.size > MAX_RESIDENT_SESSIONS) this.evictOldest();
  }

  getSession(id: string): SessionDetail | null {
    return this.cache.get(id) ?? null;
  }

  deleteSession(id: string): void {
    this.cache.delete(id);
    void this.kv
      .delete(this.keyFor(id))
      .catch((err) =>
        logger.error('session delete write-through failed', { id, error: String(err) }),
      );
  }

  /** Evict the oldest archive (cache + store) when a tenant exceeds the resident cap. */
  private evictOldest(): void {
    let oldest: SessionDetail | undefined;
    for (const detail of this.cache.values()) {
      if (!oldest || detail.startedAt < oldest.startedAt) oldest = detail;
    }
    if (oldest) this.deleteSession(oldest.id);
  }

  listSessions(limit = 50): SessionSummary[] {
    return [...this.cache.values()]
      .map(toSummary)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  exportAll(): SessionDetail[] {
    return [...this.cache.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  pruneOlderThan(cutoffMs: number): number {
    let removed = 0;
    for (const detail of [...this.cache.values()]) {
      if (detail.startedAt < cutoffMs) {
        this.deleteSession(detail.id);
        removed += 1;
      }
    }
    return removed;
  }

  deleteByChannel(channel: string): number {
    let removed = 0;
    for (const detail of [...this.cache.values()]) {
      if (detail.channel === channel) {
        this.deleteSession(detail.id);
        removed += 1;
      }
    }
    return removed;
  }

  private keyFor(id: string): string {
    return `${this.prefix}${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  }
}

function toSummary(detail: SessionDetail): SessionSummary {
  const { moments: _moments, timeline: _timeline, recap: _recap, ...summary } = detail;
  return summary;
}

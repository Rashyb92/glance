import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionDetail, SessionSummary } from '@glance/core';

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

function toSummary(detail: SessionDetail): SessionSummary {
  const { moments: _moments, timeline: _timeline, recap: _recap, ...summary } = detail;
  return summary;
}

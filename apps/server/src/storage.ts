import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionDetail, SessionSummary } from '@glance/core';

/** Persistence seam for archived sessions. Swap for SQLite/Postgres at scale. */
export interface Storage {
  saveSession(detail: SessionDetail): void;
  listSessions(limit?: number): SessionSummary[];
  getSession(id: string): SessionDetail | null;
  deleteSession(id: string): void;
}

/**
 * File-backed session archive: one JSON document per session, written atomically
 * (temp-then-rename). Reads tolerate missing/corrupt records rather than throwing.
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
    try {
      rmSync(this.fileFor(id));
    } catch {
      /* already gone */
    }
  }

  listSessions(limit = 50): SessionSummary[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      try {
        const detail = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as SessionDetail;
        summaries.push(toSummary(detail));
      } catch {
        /* skip a corrupt record rather than failing the whole list */
      }
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries.slice(0, limit);
  }

  private fileFor(id: string): string {
    return join(this.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  }
}

function toSummary(detail: SessionDetail): SessionSummary {
  const { moments: _moments, timeline: _timeline, recap: _recap, ...summary } = detail;
  return summary;
}

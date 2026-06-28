import type { KvStore } from '../kv';
import { logger } from '../logger';

/** One recorded operator action. Deliberately content-free — identifiers and outcomes only. */
export interface AuditEntry {
  /** Epoch ms. */
  ts: number;
  /** Operator name resolved from the admin token. */
  operator: string;
  /** Action performed, e.g. `view-tenant`, `force-logout`, `erase-tenant-data`, `delete-account`. */
  action: string;
  /** Target tenant id, when the action targets one. */
  tenant?: string;
  /** Free-form target detail (member id, email) — never message content. */
  detail?: string;
  /** Best-effort source IP. */
  ip?: string;
}

const KEY = 'admin:audit';
/** Default ring-buffer cap: the most-recent N actions are retained in the durable store. */
const DEFAULT_CAP = 2000;

/**
 * Append-only operator-action log for the admin/support console. Every action is emitted to the
 * structured logger (the authoritative, externally-aggregated record) and, when a {@link KvStore}
 * is supplied, appended to a capped, durable ring buffer (most-recent first) the console can read.
 *
 * The ring buffer is a read-modify-write on one key — fine at operator volume (a handful of staff,
 * deliberate actions); the logger line is the backstop if a concurrent write is lost. A high-volume
 * deployment would move this to a dedicated append-only table / log stream.
 */
export class AuditLog {
  private readonly cap: number;

  constructor(
    private readonly kv?: KvStore,
    opts: { cap?: number } = {},
  ) {
    this.cap = opts.cap && opts.cap > 0 ? Math.trunc(opts.cap) : DEFAULT_CAP;
  }

  async record(entry: AuditEntry): Promise<void> {
    logger.info('admin action', { ...entry });
    if (!this.kv) return;
    try {
      const list = await this.read();
      list.unshift(entry);
      if (list.length > this.cap) list.length = this.cap;
      await this.kv.put(KEY, JSON.stringify(list));
    } catch {
      /* durable append is best-effort — the logger line above is the backstop */
    }
  }

  async list(opts: { tenant?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    const all = await this.read();
    const filtered = opts.tenant ? all.filter((e) => e.tenant === opts.tenant) : all;
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), this.cap);
    return filtered.slice(0, limit);
  }

  private async read(): Promise<AuditEntry[]> {
    if (!this.kv) return [];
    const raw = await this.kv.get(KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AuditEntry[]) : [];
    } catch {
      return [];
    }
  }
}

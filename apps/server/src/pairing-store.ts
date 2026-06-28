import { randomBytes } from 'node:crypto';
import type { KvStore } from './kv';

/**
 * Short-lived, single-use device-pairing codes. A pairing link carries a one-time code (not the
 * owner token); the device exchanges the code for its own session token. KV-backed so a code
 * issued on one instance is consumable on another (the dashboard and the device may hit different
 * nodes); falls back to in-memory for dev / single-instance.
 */
export class PairingStore {
  private readonly mem = new Map<string, { tenant: string; exp: number }>();

  constructor(
    private readonly kv?: KvStore,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async issue(tenant: string, now = Date.now()): Promise<string> {
    const code = randomBytes(24).toString('base64url');
    const entry = { tenant, exp: now + this.ttlMs };
    if (this.kv) await this.kv.put(this.key(code), JSON.stringify(entry));
    else this.mem.set(code, entry);
    return code;
  }

  async consume(code: string, now = Date.now()): Promise<string | null> {
    if (!code) return null;
    let entry: { tenant: string; exp: number } | null = null;
    if (this.kv) {
      const raw = await this.kv.get(this.key(code));
      if (raw) {
        await this.kv.delete(this.key(code)); // one-time use
        try {
          entry = JSON.parse(raw) as { tenant: string; exp: number };
        } catch {
          entry = null;
        }
      }
    } else {
      entry = this.mem.get(code) ?? null;
      this.mem.delete(code);
    }
    if (!entry || entry.exp < now) return null;
    return entry.tenant;
  }

  private key(code: string): string {
    return `pair:${code}`;
  }
}

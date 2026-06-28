import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { KvCache, readFileOrNull } from './kv-cache';
import type { KvStore } from './kv';

export type PushPlatform = 'apns' | 'fcm' | 'webhook' | 'webpush';

export interface PushSubscription {
  id: string;
  platform: PushPlatform;
  endpoint: string; // device token (apns/fcm) or an https URL (webhook / webpush)
  createdAt: number;
  /** Web Push encryption keys (RFC 8291) — required for the `webpush` platform. */
  keys?: { p256dh: string; auth: string };
}

/**
 * Per-tenant registry of devices that receive pushes — a phone companion, an Apple
 * Watch (via its backend), or a plain https webhook. Validates the endpoint and caps
 * device count; one JSON file per tenant keeps tenants isolated on disk.
 */
export class PushStore {
  private readonly cache?: KvCache;

  constructor(
    private readonly dir: string,
    kv?: KvStore,
  ) {
    mkdirSync(dir, { recursive: true });
    if (kv) this.cache = new KvCache(kv);
  }

  list(tenant: string): PushSubscription[] {
    return this.read(tenant);
  }

  /** Warm a tenant's device list from the durable store on tenant load. No-op for files. */
  async hydrate(tenant: string): Promise<void> {
    if (this.cache) await this.cache.hydrate(`push:${this.safe(tenant)}`);
  }

  subscribe(
    tenant: string,
    platform: string,
    endpoint: string,
    keys?: { p256dh: string; auth: string },
  ): PushSubscription | { error: string } {
    if (platform !== 'apns' && platform !== 'fcm' && platform !== 'webhook' && platform !== 'webpush') {
      return { error: 'invalid platform' };
    }
    const ep = endpoint.trim();
    if (!ep || ep.length > 1000) return { error: 'invalid endpoint' };
    if ((platform === 'webhook' || platform === 'webpush') && !isSafePushEndpoint(ep)) {
      return { error: 'endpoint must be a public https url' };
    }
    if (platform === 'webpush' && (!keys?.p256dh || !keys.auth)) {
      return { error: 'webpush requires keys' };
    }
    const subs = this.read(tenant);
    const existing = subs.find((s) => s.endpoint === ep);
    if (existing) return existing; // idempotent re-register
    if (subs.length >= 20) return { error: 'too many devices' };

    const sub: PushSubscription = {
      id: randomUUID(),
      platform,
      endpoint: ep,
      createdAt: Date.now(),
    };
    if (platform === 'webpush' && keys) sub.keys = { p256dh: keys.p256dh, auth: keys.auth };
    this.write(tenant, [...subs, sub]);
    return sub;
  }

  remove(tenant: string, id: string): boolean {
    const subs = this.read(tenant);
    const next = subs.filter((s) => s.id !== id);
    if (next.length === subs.length) return false;
    this.write(tenant, next);
    return true;
  }

  private read(tenant: string): PushSubscription[] {
    const raw = this.cache ? this.cache.read(`push:${this.safe(tenant)}`) : readFileOrNull(this.fileFor(tenant));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PushSubscription[]) : [];
    } catch {
      return [];
    }
  }
  private write(tenant: string, subs: PushSubscription[]): void {
    if (this.cache) {
      this.cache.write(`push:${this.safe(tenant)}`, JSON.stringify(subs));
      return;
    }
    const file = this.fileFor(tenant);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(subs), 'utf8');
    renameSync(tmp, file);
  }
  private safe(tenant: string): string {
    return tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  }
  private fileFor(tenant: string): string {
    const safe = tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    return join(this.dir, `${safe}.json`);
  }
}

/**
 * Guards the server-side push fetch against SSRF: only public `https` URLs are allowed.
 * Literal private / loopback / link-local / CGNAT / cloud-metadata hosts are rejected, so a
 * registered "device" can't make the server POST to internal services or 169.254.169.254.
 * (DNS names that resolve to private IPs are out of scope here — use egress controls.)
 */
/** True for literal private / loopback / link-local / CGNAT / unique-local addresses (v4 + v6). */
export function isPrivateIp(ip: string): boolean {
  const host = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true; // this-network / private / loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (host.includes(':')) {
    // IPv6 loopback / link-local / unique-local literals.
    return host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd');
  }
  return false;
}

export function isSafePushEndpoint(ep: string): boolean {
  let url: URL;
  try {
    url = new URL(ep);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return !isPrivateIp(host); // literal-IP check; isPublicEndpoint adds DNS resolution at send time
}

/**
 * Send-time SSRF guard: resolves the endpoint's hostname and rejects if any resolved address is
 * private / loopback / cloud-metadata — defending against DNS rebinding that passed the
 * subscribe-time literal check. Literal IPs are already validated by {@link isSafePushEndpoint}.
 */
export async function isPublicEndpoint(ep: string): Promise<boolean> {
  if (!isSafePushEndpoint(ep)) return false;
  let host: string;
  try {
    host = new URL(ep).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return true; // literal IP — already checked
  try {
    const records = await lookup(host, { all: true });
    return records.length > 0 && records.every((r) => !isPrivateIp(r.address));
  } catch {
    return false; // unresolvable → don't send
  }
}

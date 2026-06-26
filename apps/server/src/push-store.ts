import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type PushPlatform = 'apns' | 'fcm' | 'webhook';

export interface PushSubscription {
  id: string;
  platform: PushPlatform;
  endpoint: string; // device token (apns/fcm) or an https URL (webhook)
  createdAt: number;
}

/**
 * Per-tenant registry of devices that receive pushes — a phone companion, an Apple
 * Watch (via its backend), or a plain https webhook. Validates the endpoint and caps
 * device count; one JSON file per tenant keeps tenants isolated on disk.
 */
export class PushStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  list(tenant: string): PushSubscription[] {
    return this.read(tenant);
  }

  subscribe(
    tenant: string,
    platform: string,
    endpoint: string,
  ): PushSubscription | { error: string } {
    if (platform !== 'apns' && platform !== 'fcm' && platform !== 'webhook') {
      return { error: 'invalid platform' };
    }
    const ep = endpoint.trim();
    if (!ep || ep.length > 500) return { error: 'invalid endpoint' };
    if (platform === 'webhook' && !/^https:\/\/[^\s"'<>]{1,500}$/.test(ep)) {
      return { error: 'webhook must be https' };
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
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.fileFor(tenant), 'utf8'));
      return Array.isArray(parsed) ? (parsed as PushSubscription[]) : [];
    } catch {
      return [];
    }
  }
  private write(tenant: string, subs: PushSubscription[]): void {
    const file = this.fileFor(tenant);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(subs), 'utf8');
    renameSync(tmp, file);
  }
  private fileFor(tenant: string): string {
    const safe = tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    return join(this.dir, `${safe}.json`);
  }
}

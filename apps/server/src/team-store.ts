import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isTeamRole, type TeamMember, type TeamRole } from '@glance/core';
import { KvCache, readFileOrNull } from './kv-cache';
import type { KvStore } from './kv';

/**
 * Per-tenant team roster (one JSON file per tenant). Enforces a valid email, a
 * non-owner invite role, no duplicates, and the plan's seat limit. The tenant owner
 * is implicit and not stored, so `seatLimit` bounds the number of invited members.
 */
export class TeamStore {
  private readonly cache?: KvCache;

  constructor(
    private readonly dir: string,
    kv?: KvStore,
  ) {
    mkdirSync(dir, { recursive: true });
    if (kv) this.cache = new KvCache(kv);
  }

  list(tenant: string): TeamMember[] {
    return this.read(tenant);
  }

  invite(
    tenant: string,
    email: string,
    role: TeamRole,
    seatLimit: number,
  ): TeamMember | { error: string } {
    const cleanEmail = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return { error: 'invalid email' };
    if (!isTeamRole(role) || role === 'owner') return { error: 'invalid role' };
    const members = this.read(tenant);
    if (members.some((m) => m.email === cleanEmail)) return { error: 'already a member' };
    if (members.length >= seatLimit) return { error: 'seat limit reached' };

    const member: TeamMember = {
      id: randomUUID(),
      email: cleanEmail,
      role,
      status: 'invited',
      invitedAt: Date.now(),
    };
    this.write(tenant, [...members, member]);
    return member;
  }

  remove(tenant: string, id: string): boolean {
    const members = this.read(tenant);
    const next = members.filter((m) => m.id !== id);
    if (next.length === members.length) return false;
    this.write(tenant, next);
    return true;
  }

  private read(tenant: string): TeamMember[] {
    const raw = this.cache ? this.cache.read(`team:${this.safe(tenant)}`) : readFileOrNull(this.fileFor(tenant));
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TeamMember[]) : [];
    } catch {
      return [];
    }
  }

  private write(tenant: string, members: TeamMember[]): void {
    if (this.cache) {
      this.cache.write(`team:${this.safe(tenant)}`, JSON.stringify(members));
      return;
    }
    const file = this.fileFor(tenant);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(members), 'utf8');
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

/**
 * In-memory denylist of revoked members for instant token revocation. Removing a member —
 * or an explicit force-logout — adds them here, so their signed token is rejected on the
 * next request/connection without waiting for the 30-day TTL. Per-instance today; broadcast
 * revocations over the bus to make it instant fleet-wide.
 */
export class MemberDenylist {
  private readonly revoked = new Set<string>();

  private key(tenant: string, memberId: string): string {
    return `${tenant}:${memberId}`;
  }

  revoke(tenant: string, memberId: string): void {
    this.revoked.add(this.key(tenant, memberId));
  }

  restore(tenant: string, memberId: string): void {
    this.revoked.delete(this.key(tenant, memberId));
  }

  isRevoked(tenant: string, memberId: string): boolean {
    return this.revoked.has(this.key(tenant, memberId));
  }
}

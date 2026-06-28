import { describe, it, expect, afterEach } from 'vitest';
import { signSessionToken, signMemberToken, resolveActor } from '../src/auth';
import { AuthService, AccountStore } from '../src/accounts';
import { MemoryKvStore } from '../src/kv';

describe('session tokens', () => {
  afterEach(() => {
    delete process.env['GLANCE_AUTH_SECRET'];
  });

  it('round-trips through resolveActor as an owner carrying sessionId + issuedAt', () => {
    process.env['GLANCE_AUTH_SECRET'] = 'secret';
    const token = signSessionToken('tenantX', 'sess-1', 'secret', { ttlSeconds: 3600 });
    const actor = resolveActor(token);
    expect(actor?.tenant).toBe('tenantX');
    expect(actor?.role).toBe('owner');
    expect(actor?.sessionId).toBe('sess-1');
    expect(typeof actor?.issuedAt).toBe('number');
    expect(actor?.memberId).toBeUndefined();
  });

  it('keeps member and session tokens distinct (both 5-segment)', () => {
    process.env['GLANCE_AUTH_SECRET'] = 'secret';
    const member = signMemberToken('t', 'm1', 'admin', 'secret', { ttlSeconds: 3600 });
    const session = signSessionToken('t', 's1', 'secret', { ttlSeconds: 3600 });
    const ma = resolveActor(member);
    const sa = resolveActor(session);
    expect(ma?.memberId).toBe('m1');
    expect(ma?.sessionId).toBeUndefined();
    expect(sa?.sessionId).toBe('s1');
    expect(sa?.memberId).toBeUndefined();
  });

  it('rejects a tampered session signature', () => {
    process.env['GLANCE_AUTH_SECRET'] = 'secret';
    const token = signSessionToken('t', 's1', 'secret', { ttlSeconds: 3600 });
    const forged = `${token.slice(0, -2)}xx`;
    expect(resolveActor(forged)).toBeNull();
  });
});

describe('AuthService.issueTicket', () => {
  afterEach(() => {
    delete process.env['GLANCE_AUTH_SECRET'];
  });

  it('issues a short-lived ticket that preserves owner vs member identity', () => {
    process.env['GLANCE_AUTH_SECRET'] = 'secret';
    const svc = new AuthService(new AccountStore(new MemoryKvStore()), 'secret');

    const ownerTicket = svc.issueTicket({ tenant: 't', role: 'owner' });
    const memberTicket = svc.issueTicket({ tenant: 't', role: 'admin', memberId: 'm1' });

    expect(resolveActor(ownerTicket.token)?.sessionId).toBeDefined();
    expect(resolveActor(ownerTicket.token)?.memberId).toBeUndefined();
    expect(resolveActor(memberTicket.token)?.memberId).toBe('m1');
    // ~30s lifetime, not the 7-day session
    expect(ownerTicket.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(31);
  });
});

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveActor, resolveTenant, signMemberToken, signToken } from '../src/auth';

const KEY = 'GLANCE_AUTH_SECRET';

/** Craft a validly-signed token with an explicit (possibly past) expiry. */
function tokenWithExp(tenant: string, secret: string, expEpochSec: number): string {
  const body = `${tenant}.${expEpochSec}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function memberTokenWithExp(
  tenant: string,
  memberId: string,
  role: string,
  secret: string,
  expEpochSec: number,
): string {
  const body = `${tenant}.${memberId}.${role}.${expEpochSec}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

describe('resolveTenant — dev mode (no secret)', () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it('falls back to the default tenant when no usable token is given', () => {
    delete process.env[KEY];
    expect(resolveTenant(undefined)).toBe('default');
    expect(resolveTenant('')).toBe('default');
    expect(resolveTenant('   ')).toBe('default');
  });

  it('uses the raw token as the tenant key', () => {
    delete process.env[KEY];
    expect(resolveTenant('acme')).toBe('acme');
  });
});

describe('resolveTenant — production (signed tokens)', () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it('accepts a token signed with the active secret', () => {
    process.env[KEY] = 'top-secret';
    expect(resolveTenant(signToken('acme', 'top-secret'))).toBe('acme');
  });

  it('rejects a missing, unsigned, or malformed token', () => {
    process.env[KEY] = 'top-secret';
    expect(resolveTenant(undefined)).toBeNull();
    expect(resolveTenant('acme')).toBeNull();
    expect(resolveTenant('acme.deadbeef')).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    process.env[KEY] = 'top-secret';
    expect(resolveTenant(signToken('acme', 'wrong-secret'))).toBeNull();
  });

  it('rejects a tampered tenant that reuses another tenant’s signature', () => {
    process.env[KEY] = 'top-secret';
    const token = signToken('acme', 'top-secret');
    const forged = `evil${token.slice(token.lastIndexOf('.'))}`;
    expect(resolveTenant(forged)).toBeNull();
  });

  it('accepts a token within its TTL', () => {
    process.env[KEY] = 'top-secret';
    expect(resolveTenant(signToken('acme', 'top-secret', { ttlSeconds: 3600 }))).toBe('acme');
  });

  it('rejects an expired token even though the signature is valid', () => {
    process.env[KEY] = 'top-secret';
    const expired = tokenWithExp('acme', 'top-secret', Math.floor(Date.now() / 1000) - 10);
    expect(resolveTenant(expired)).toBeNull();
  });
});

describe('resolveActor — per-member logins', () => {
  afterEach(() => {
    delete process.env[KEY];
  });

  it('resolves tenant tokens (and dev tokens) as owner', () => {
    delete process.env[KEY];
    expect(resolveActor('acme')).toEqual({ tenant: 'acme', role: 'owner' });
    expect(resolveActor(undefined)).toEqual({ tenant: 'default', role: 'owner' });
    process.env[KEY] = 'top-secret';
    expect(resolveActor(signToken('acme', 'top-secret'))).toEqual({ tenant: 'acme', role: 'owner' });
  });

  it('round-trips a signed member token with its id and role', () => {
    process.env[KEY] = 'top-secret';
    const token = signMemberToken('acme', 'mem-1', 'admin', 'top-secret');
    expect(resolveActor(token)).toEqual({ tenant: 'acme', memberId: 'mem-1', role: 'admin' });
  });

  it('rejects a member token signed with a different secret', () => {
    process.env[KEY] = 'top-secret';
    expect(resolveActor(signMemberToken('acme', 'mem-1', 'member', 'wrong-secret'))).toBeNull();
  });

  it('rejects a privilege-escalation tamper of the role', () => {
    process.env[KEY] = 'top-secret';
    const token = signMemberToken('acme', 'mem-1', 'member', 'top-secret');
    expect(resolveActor(token.replace('.member.', '.owner.'))).toBeNull();
  });

  it('rejects a validly-signed but unknown role', () => {
    process.env[KEY] = 'top-secret';
    expect(resolveActor(memberTokenWithExp('acme', 'm', 'superuser', 'top-secret', 0))).toBeNull();
  });

  it('rejects an expired member token', () => {
    process.env[KEY] = 'top-secret';
    const expired = memberTokenWithExp(
      'acme',
      'm',
      'admin',
      'top-secret',
      Math.floor(Date.now() / 1000) - 10,
    );
    expect(resolveActor(expired)).toBeNull();
  });
});

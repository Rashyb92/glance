import { describe, it, expect } from 'vitest';
import { AccountStore, AuthService, hashPassword, verifyPassword } from '../src/accounts';
import { MemoryKvStore } from '../src/kv';
import { resolveActor } from '../src/auth';

describe('password hashing', () => {
  it('hashes and verifies, and rejects a wrong password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('rejects a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('AuthService', () => {
  const SECRET = 'test-auth-secret';
  const make = (): AuthService => new AuthService(new AccountStore(new MemoryKvStore()), SECRET);

  it('signs up then logs in, issuing a token that resolves to the account tenant as owner', async () => {
    const svc = make();
    const signed = await svc.signup('User@Example.com', 'hunter2hunter');
    expect('token' in signed).toBe(true);
    if (!('token' in signed)) return;

    const prev = process.env['GLANCE_AUTH_SECRET'];
    process.env['GLANCE_AUTH_SECRET'] = SECRET;
    try {
      const actor = resolveActor(signed.token);
      expect(actor?.tenant).toBe(signed.tenant);
      expect(actor?.role).toBe('owner');
    } finally {
      if (prev === undefined) delete process.env['GLANCE_AUTH_SECRET'];
      else process.env['GLANCE_AUTH_SECRET'] = prev;
    }

    const login = await svc.login('user@example.com', 'hunter2hunter'); // email is normalized
    expect('token' in login).toBe(true);
    if ('token' in login) expect(login.tenant).toBe(signed.tenant);
  });

  it('rejects duplicate signup, short passwords, bad emails, and wrong credentials', async () => {
    const svc = make();
    expect('token' in (await svc.signup('a@b.com', 'longenoughpw'))).toBe(true);
    expect(await svc.signup('a@b.com', 'longenoughpw')).toEqual({ error: expect.any(String) });
    expect(await svc.signup('a@b.com', 'short')).toEqual({ error: expect.any(String) });
    expect(await svc.signup('not-an-email', 'longenoughpw')).toEqual({ error: expect.any(String) });
    expect(await svc.login('a@b.com', 'wrongpassword')).toEqual({ error: expect.any(String) });
    expect(await svc.login('nobody@b.com', 'whatever12')).toEqual({ error: expect.any(String) });
  });

  it('refresh issues a fresh token for the tenant', () => {
    const session = make().refresh('tenant-x');
    expect(session.tenant).toBe('tenant-x');
    expect(typeof session.token).toBe('string');
    expect(session.token.length).toBeGreaterThan(0);
  });
});

describe('AuthService.deleteAccount', () => {
  it('deletes after re-auth, frees the tenant, and rejects bad credentials', async () => {
    const accounts = new AccountStore(new MemoryKvStore());
    const svc = new AuthService(accounts, 'test-auth-secret');
    const signed = await svc.signup('user@example.com', 'hunter2hunter');
    if (!('token' in signed)) throw new Error('signup failed');

    expect(await svc.deleteAccount('user@example.com', 'wrong')).toBeNull(); // bad password
    expect(await accounts.get('user@example.com')).not.toBeNull(); // intact after a bad attempt

    expect(await svc.deleteAccount('user@example.com', 'hunter2hunter')).toBe(signed.tenant);
    expect(await accounts.get('user@example.com')).toBeNull(); // record gone
    expect(await svc.login('user@example.com', 'hunter2hunter')).toEqual({ error: expect.any(String) });
  });
});

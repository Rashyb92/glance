import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { signSessionToken } from './auth';
import type { KvStore } from './kv';
import type { SessionStore } from './session-store';

/**
 * Self-serve account identity — the layer that turns Glance from "provisioned tenant tokens"
 * into a real multi-user SaaS. An account (email + scrypt-hashed password) owns a tenant;
 * login issues a short-lived, rotating session token (the same HMAC tenant token the gateway
 * already verifies, so an account holder resolves as the owner of their tenant). Tokens are
 * acquired at runtime via login — never baked into a client build.
 */
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 8;
const MAX_FIELD = 200;

export interface Account {
  id: string;
  email: string;
  passwordHash: string;
  tenant: string;
  createdAt: number;
}

export interface AuthSession {
  token: string;
  tenant: string;
  /** Unix seconds when the token expires (0 = non-expiring, dev only). */
  expiresAt: number;
}

/** Hash a password with scrypt (random 16-byte salt). Encoded `scrypt$<salt>$<hash>` (base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** Constant-time verify a password against a stored `scrypt$<salt>$<hash>`. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  let actual: Buffer;
  try {
    actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Account records keyed by a hash of the (lowercased) email — so emails aren't exposed as
 * store keys. Postgres-backed (shared across instances) when a KvStore is supplied, else
 * in-memory for dev/tests.
 */
export class AccountStore {
  private readonly mem = new Map<string, Account>();

  constructor(private readonly kv?: KvStore) {}

  private key(email: string): string {
    return `account:${createHash('sha256').update(email).digest('hex')}`;
  }

  async get(email: string): Promise<Account | null> {
    const k = this.key(email);
    if (this.kv) {
      const raw = await this.kv.get(k);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Account;
      } catch {
        return null;
      }
    }
    return this.mem.get(k) ?? null;
  }

  async create(account: Account): Promise<void> {
    const k = this.key(account.email);
    if (this.kv) {
      await this.kv.put(k, JSON.stringify(account));
      return;
    }
    this.mem.set(k, account);
  }
}

export class AuthService {
  private dummy?: string;

  constructor(
    private readonly accounts: AccountStore,
    private readonly secret: string | undefined,
    private readonly sessions?: SessionStore,
    private readonly sessionTtlSeconds = 7 * 24 * 3600,
  ) {}

  async signup(email: string, password: string): Promise<AuthSession | { error: string }> {
    const clean = String(email ?? '').trim().toLowerCase();
    if (clean.length > MAX_FIELD || !EMAIL_RE.test(clean)) return { error: 'invalid email' };
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_FIELD) {
      return { error: 'password must be at least 8 characters' };
    }
    if (await this.accounts.get(clean)) return { error: 'an account with that email already exists' };

    const id = randomUUID();
    const account: Account = {
      id,
      email: clean,
      passwordHash: await hashPassword(password),
      tenant: id,
      createdAt: Date.now(),
    };
    await this.accounts.create(account);
    return this.issue(account.tenant);
  }

  async login(email: string, password: string): Promise<AuthSession | { error: string }> {
    const clean = String(email ?? '').trim().toLowerCase();
    const account = clean.length <= MAX_FIELD ? await this.accounts.get(clean) : null;
    // Hash either way to keep timing uniform — resists account-enumeration via response time.
    const stored = account?.passwordHash ?? (await this.dummyHash());
    const ok = await verifyPassword(typeof password === 'string' ? password : '', stored);
    if (!account || !ok) return { error: 'invalid email or password' };
    return this.issue(account.tenant);
  }

  /** Rotate a session: reissue a fresh token for an already-authenticated tenant. */
  refresh(tenant: string): AuthSession {
    return this.issue(tenant);
  }

  /** Log out a single session (the one making the request). */
  logout(tenant: string, sessionId: string): void {
    this.sessions?.revoke(tenant, sessionId);
  }

  /** Sign out everywhere — revoke every session for the account (stolen-token kill switch). */
  revokeAll(tenant: string): void {
    this.sessions?.revokeAll(tenant);
  }

  private issue(tenant: string): AuthSession {
    if (!this.secret) return { token: tenant, tenant, expiresAt: 0 }; // dev mode: token == tenant key
    return {
      token: signSessionToken(tenant, randomUUID(), this.secret, {
        ttlSeconds: this.sessionTtlSeconds,
      }),
      tenant,
      expiresAt: Math.floor(Date.now() / 1000) + this.sessionTtlSeconds,
    };
  }

  private async dummyHash(): Promise<string> {
    return (this.dummy ??= await hashPassword('unused-placeholder-for-uniform-timing'));
  }
}

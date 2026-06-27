import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decryptSecret, encryptSecret } from './oauth-crypto';
import type { ProviderId } from './oauth-providers';
import type { OAuthTokens } from './oauth-service';
import { KvCache, readFileOrNull } from '../kv-cache';
import type { KvStore } from '../kv';

interface StoredTokens {
  accessToken: string; // encrypted
  refreshToken?: string; // encrypted
  expiresAt: number;
  scope?: string;
}

/**
 * Per-(tenant, provider) token store. Access/refresh tokens are encrypted at rest
 * (see oauth-crypto). One file per link keeps tenants isolated on disk, mirroring
 * the session archive layout.
 */
export class TokenStore {
  private readonly cache?: KvCache;

  constructor(
    private readonly dir: string,
    kv?: KvStore,
  ) {
    mkdirSync(dir, { recursive: true });
    if (kv) this.cache = new KvCache(kv);
  }

  save(tenant: string, provider: ProviderId, tokens: OAuthTokens): void {
    const payload: StoredTokens = {
      accessToken: encryptSecret(tokens.accessToken),
      expiresAt: tokens.expiresAt,
    };
    if (tokens.refreshToken) payload.refreshToken = encryptSecret(tokens.refreshToken);
    if (tokens.scope) payload.scope = tokens.scope;

    const json = JSON.stringify(payload);
    if (this.cache) {
      this.cache.write(this.keyFor(tenant, provider), json);
      return;
    }
    const file = this.fileFor(tenant, provider);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, json, 'utf8');
    renameSync(tmp, file);
  }

  load(tenant: string, provider: ProviderId): OAuthTokens | null {
    const rawStr = this.cache
      ? this.cache.read(this.keyFor(tenant, provider))
      : readFileOrNull(this.fileFor(tenant, provider));
    if (!rawStr) return null;
    try {
      const raw = JSON.parse(rawStr) as StoredTokens;
      return {
        accessToken: decryptSecret(raw.accessToken),
        refreshToken: raw.refreshToken ? decryptSecret(raw.refreshToken) : undefined,
        expiresAt: raw.expiresAt,
        scope: raw.scope,
      };
    } catch {
      return null;
    }
  }

  /** Warm a (tenant, provider) token from the durable store so a fresh instance picks the
   *  authenticated reader (EventSub / YouTube) instead of falling back to IRC/demo. No-op for files. */
  async hydrate(tenant: string, provider: ProviderId): Promise<void> {
    if (this.cache) await this.cache.hydrate(this.keyFor(tenant, provider));
  }

  private safe(tenant: string): string {
    return tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
  }

  private keyFor(tenant: string, provider: ProviderId): string {
    return `tok:${this.safe(tenant)}:${provider}`;
  }

  private fileFor(tenant: string, provider: ProviderId): string {
    return join(this.dir, `${this.safe(tenant)}.${provider}.json`);
  }
}

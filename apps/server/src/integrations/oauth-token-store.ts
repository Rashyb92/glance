import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decryptSecret, encryptSecret } from './oauth-crypto';
import type { ProviderId } from './oauth-providers';
import type { OAuthTokens } from './oauth-service';

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
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  save(tenant: string, provider: ProviderId, tokens: OAuthTokens): void {
    const payload: StoredTokens = {
      accessToken: encryptSecret(tokens.accessToken),
      expiresAt: tokens.expiresAt,
    };
    if (tokens.refreshToken) payload.refreshToken = encryptSecret(tokens.refreshToken);
    if (tokens.scope) payload.scope = tokens.scope;

    const file = this.fileFor(tenant, provider);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, file);
  }

  load(tenant: string, provider: ProviderId): OAuthTokens | null {
    try {
      const raw = JSON.parse(readFileSync(this.fileFor(tenant, provider), 'utf8')) as StoredTokens;
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

  private fileFor(tenant: string, provider: ProviderId): string {
    const safe = tenant.replace(/[^a-zA-Z0-9_-]/g, '') || 'default';
    return join(this.dir, `${safe}.${provider}.json`);
  }
}

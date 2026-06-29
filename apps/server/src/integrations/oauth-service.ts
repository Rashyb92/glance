import { PROVIDERS, type ProviderId } from './oauth-providers';
import { createPkce } from './oauth-crypto';

/** Tokens returned by a provider's token endpoint, normalized. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number; // epoch ms
  scope: string | undefined;
}

export interface AuthorizeRequest {
  url: string;
  state: string;
  /** Present for PKCE providers — the caller must persist it alongside `state`. */
  verifier: string | undefined;
}

/**
 * Drives the Authorization-Code flow for every provider. Pure URL construction for
 * the authorize step (unit-tested); `fetch` for the token exchange/refresh. Uses
 * the global `fetch` (Node 20+) so it needs no SDK dependency — swap in an official
 * SDK later behind the same surface if desired.
 */
export class OAuthService {
  constructor(private readonly redirectBase: string) {}

  /** True when this provider's client credentials are configured. */
  available(provider: ProviderId): boolean {
    return Boolean(process.env[PROVIDERS[provider].clientIdEnv]);
  }

  buildAuthorize(provider: ProviderId, state: string): AuthorizeRequest {
    const cfg = PROVIDERS[provider];
    const params = new URLSearchParams({
      client_id: process.env[cfg.clientIdEnv] ?? '',
      redirect_uri: this.redirectUri(provider),
      response_type: 'code',
      scope: cfg.scopes.join(' '),
      state,
    });
    let verifier: string | undefined;
    if (cfg.usesPkce) {
      const pkce = createPkce();
      verifier = pkce.verifier;
      params.set('code_challenge', pkce.challenge);
      params.set('code_challenge_method', 'S256');
    }
    return { url: `${cfg.authorizeUrl}?${params.toString()}`, state, verifier };
  }

  async exchangeCode(provider: ProviderId, code: string, verifier?: string): Promise<OAuthTokens> {
    const cfg = PROVIDERS[provider];
    const body = new URLSearchParams({
      client_id: process.env[cfg.clientIdEnv] ?? '',
      client_secret: process.env[cfg.clientSecretEnv] ?? '',
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri(provider),
    });
    if (verifier) body.set('code_verifier', verifier);
    return this.tokenRequest(cfg.tokenUrl, body);
  }

  async refresh(provider: ProviderId, refreshToken: string): Promise<OAuthTokens> {
    const cfg = PROVIDERS[provider];
    const body = new URLSearchParams({
      client_id: process.env[cfg.clientIdEnv] ?? '',
      client_secret: process.env[cfg.clientSecretEnv] ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return this.tokenRequest(cfg.tokenUrl, body);
  }

  private redirectUri(provider: ProviderId): string {
    return `${this.redirectBase}/api/oauth/${provider}/callback`;
  }

  private async tokenRequest(url: string, body: URLSearchParams): Promise<OAuthTokens> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`token endpoint responded ${res.status}`);
    const json = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string | string[];
    };
    if (!json.access_token) throw new Error('token endpoint returned no access_token');
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      scope: Array.isArray(json.scope) ? json.scope.join(' ') : json.scope,
    };
  }
}

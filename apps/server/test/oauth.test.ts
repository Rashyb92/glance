import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkce, decryptSecret, encryptSecret } from '../src/integrations/oauth-crypto';
import { OAuthService } from '../src/integrations/oauth-service';

describe('oauth-crypto', () => {
  afterEach(() => {
    delete process.env['GLANCE_TOKEN_KEY'];
  });

  it('round-trips a secret through AES-256-GCM', () => {
    process.env['GLANCE_TOKEN_KEY'] = 'unit-test-key';
    const blob = encryptSecret('super-secret-token');
    expect(blob).not.toContain('super-secret-token');
    expect(decryptSecret(blob)).toBe('super-secret-token');
  });

  it('fails closed when no key is configured', () => {
    delete process.env['GLANCE_TOKEN_KEY'];
    expect(() => encryptSecret('x')).toThrow();
  });

  it('creates a valid PKCE S256 challenge', () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('OAuthService.buildAuthorize', () => {
  afterEach(() => {
    delete process.env['TWITCH_CLIENT_ID'];
    delete process.env['KICK_CLIENT_ID'];
  });

  it('builds a Twitch authorize URL with scope + redirect, no PKCE', () => {
    process.env['TWITCH_CLIENT_ID'] = 'cid';
    const { url, verifier } = new OAuthService('https://glance.app').buildAuthorize('twitch', 'st8');
    expect(url).toContain('https://id.twitch.tv/oauth2/authorize?');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('scope=user%3Aread%3Achat');
    expect(url).toContain('redirect_uri=https%3A%2F%2Fglance.app%2Fapi%2Foauth%2Ftwitch%2Fcallback');
    expect(url).toContain('state=st8');
    expect(verifier).toBeUndefined();
  });

  it('adds a PKCE challenge for Kick (OAuth 2.1)', () => {
    process.env['KICK_CLIENT_ID'] = 'kid';
    const { url, verifier } = new OAuthService('https://glance.app').buildAuthorize('kick', 'st8');
    expect(url).toContain('code_challenge=');
    expect(url).toContain('code_challenge_method=S256');
    expect(typeof verifier).toBe('string');
  });
});

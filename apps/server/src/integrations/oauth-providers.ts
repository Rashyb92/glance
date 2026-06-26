/**
 * OAuth provider registry. Endpoints + scopes for each streaming platform Glance
 * can link to. Credentials are read from the environment at runtime, so adding a
 * provider in production is config-only. Scopes are conservative read defaults —
 * confirm against each provider's current docs before go-live (they evolve).
 */
export type ProviderId = 'twitch' | 'youtube' | 'kick';

export interface ProviderConfig {
  id: ProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Kick uses OAuth 2.1 + PKCE; Twitch/YouTube use a client secret. */
  usesPkce: boolean;
  clientIdEnv: string;
  clientSecretEnv: string;
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  // Twitch: read chat via EventSub channel.chat.message (User Access Token).
  twitch: {
    id: 'twitch',
    authorizeUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scopes: ['user:read:chat'],
    usesPkce: false,
    clientIdEnv: 'TWITCH_CLIENT_ID',
    clientSecretEnv: 'TWITCH_CLIENT_SECRET',
  },
  // YouTube: read live chat via the Live Streaming API (Google OAuth 2.0).
  youtube: {
    id: 'youtube',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    usesPkce: false,
    clientIdEnv: 'YOUTUBE_CLIENT_ID',
    clientSecretEnv: 'YOUTUBE_CLIENT_SECRET',
  },
  // Kick: OAuth 2.1 + PKCE against id.kick.com / api.kick.com.
  kick: {
    id: 'kick',
    authorizeUrl: 'https://id.kick.com/oauth/authorize',
    tokenUrl: 'https://id.kick.com/oauth/token',
    scopes: ['chat:read'],
    usesPkce: true,
    clientIdEnv: 'KICK_CLIENT_ID',
    clientSecretEnv: 'KICK_CLIENT_SECRET',
  },
};

export function isProviderId(value: string): value is ProviderId {
  return value === 'twitch' || value === 'youtube' || value === 'kick';
}

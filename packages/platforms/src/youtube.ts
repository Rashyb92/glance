import type { ChatMessage, ChatRole } from '@glance/core';
import type { AdapterHandlers, PlatformAdapter } from './adapter';

const YT_API = 'https://www.googleapis.com/youtube/v3';

export interface YouTubeOptions {
  /** Returns a current Google OAuth access token, or null if the link is gone. */
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** Lower bound on poll interval (the API also returns a suggested interval). */
  pollFloorMs?: number;
}

/**
 * Reads a live YouTube chat via the Live Streaming API. Unlike Twitch/Kick this is
 * poll-based: resolve the active broadcast's `liveChatId`, then page through
 * `liveChat/messages`, honoring the API's suggested polling interval. Behind the same
 * {@link PlatformAdapter} contract, so the engine is unchanged.
 */
export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube' as const;
  readonly channel: string;

  private handlers: AdapterHandlers | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pageToken: string | undefined;
  private liveChatId: string | null = null;
  private token: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly pollFloorMs: number;

  constructor(
    channel: string,
    private readonly opts: YouTubeOptions,
  ) {
    this.channel = channel.toLowerCase();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollFloorMs = opts.pollFloorMs ?? 3000;
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    handlers.onStatus?.({ state: 'connecting' });
    this.token = await this.opts.getToken();
    if (!this.token) {
      handlers.onStatus?.({ state: 'closed', reason: 'no youtube token' });
      return;
    }
    this.liveChatId = await this.resolveLiveChatId(this.token);
    if (!this.liveChatId) {
      handlers.onStatus?.({ state: 'closed', reason: 'no active broadcast' });
      return;
    }
    handlers.onStatus?.({ state: 'connected' });
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.liveChatId || !this.token) return;
    let nextDelay = this.pollFloorMs;
    try {
      const params = new URLSearchParams({
        liveChatId: this.liveChatId,
        part: 'snippet,authorDetails',
      });
      if (this.pageToken) params.set('pageToken', this.pageToken);
      const res = await this.fetchImpl(`${YT_API}/liveChat/messages?${params.toString()}`, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      if (res.ok) {
        const json = (await res.json()) as {
          items?: unknown[];
          nextPageToken?: string;
          pollingIntervalMillis?: number;
        };
        this.pageToken = json.nextPageToken;
        for (const item of json.items ?? []) {
          if (item && typeof item === 'object') {
            this.handlers?.onMessage(youtubeToChatMessage(this.channel, item as Record<string, unknown>));
          }
        }
        nextDelay = Math.max(this.pollFloorMs, json.pollingIntervalMillis ?? this.pollFloorMs);
      } else if (res.status === 403 || res.status === 401) {
        this.handlers?.onStatus?.({ state: 'closed', reason: `auth (${res.status})` });
        return;
      }
    } catch (err) {
      this.handlers?.onStatus?.({ state: 'reconnecting', reason: (err as Error).message });
      nextDelay = Math.max(this.pollFloorMs, 5000);
    }
    this.timer = setTimeout(() => void this.poll(), nextDelay);
  }

  private async resolveLiveChatId(token: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(
        `${YT_API}/liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;
      const json = (await res.json()) as {
        items?: Array<{ snippet?: { liveChatId?: string } }>;
      };
      return json.items?.[0]?.snippet?.liveChatId ?? null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Parse a YouTube liveChatMessage resource into a normalized ChatMessage. */
export function youtubeToChatMessage(channel: string, item: Record<string, unknown>): ChatMessage {
  const snippet = (item['snippet'] as Record<string, unknown> | undefined) ?? {};
  const author = (item['authorDetails'] as Record<string, unknown> | undefined) ?? {};
  const superChat = snippet['superChatDetails'] as { amountMicros?: string | number } | undefined;
  const micros = superChat ? Number(superChat.amountMicros) : 0;
  // Map a Super Chat amount to a positive "bits-like" magnitude (in cents).
  const bits = Number.isFinite(micros) && micros > 0 ? Math.round(micros / 10_000) : undefined;
  return {
    id: asString(item['id']) ?? randomId(),
    platform: 'youtube',
    channel,
    author: asString(author['displayName']) ?? 'unknown',
    authorId: asString(author['channelId']),
    text: asString(snippet['displayMessage']) ?? '',
    timestamp: Date.now(),
    bits,
    roles: rolesFromYouTube(author),
  };
}

export function rolesFromYouTube(author: Record<string, unknown>): ChatRole[] {
  const roles: ChatRole[] = [];
  if (author['isChatOwner'] === true) roles.push('broadcaster');
  if (author['isChatModerator'] === true) roles.push('moderator');
  if (author['isChatSponsor'] === true) roles.push('subscriber');
  return roles;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

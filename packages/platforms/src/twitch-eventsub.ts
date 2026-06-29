import WebSocket from 'ws';
import type { ChatMessage, ChatRole } from '@glance/core';
import type { AdapterHandlers, PlatformAdapter } from './adapter';

const EVENTSUB_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX = 'https://api.twitch.tv/helix';

export interface TwitchEventSubOptions {
  clientId: string;
  /** Returns a current (refreshed) user access token, or null if the link is gone. */
  getToken: () => Promise<string | null>;
  // Injectable seams for tests.
  wsUrl?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

interface ResolvedIds {
  broadcasterId: string;
  userId: string;
}

/**
 * Reads live Twitch chat over EventSub (`channel.chat.message`) using a user access
 * token — the modern replacement for IRC. Behind the same {@link PlatformAdapter}
 * contract as the anonymous IRC reader, so the engine is unchanged; the server picks
 * EventSub when a linked token exists and falls back to IRC otherwise.
 *
 * Flow: open the EventSub WebSocket → on `session_welcome` create the chat
 * subscription via Helix with the session id → receive `notification`s → emit.
 */
export class TwitchEventSubAdapter implements PlatformAdapter {
  readonly platform = 'twitch' as const;
  readonly channel: string;

  private ws: WebSocket | null = null;
  private handlers: AdapterHandlers | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private reconnectScheduled = false;
  private token: string | null = null;
  private ids: ResolvedIds | null = null;

  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly wsUrl: string;

  constructor(
    channel: string,
    private readonly opts: TwitchEventSubOptions,
  ) {
    this.channel = channel.replace(/^#/, '').toLowerCase();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.wsUrl = opts.wsUrl ?? EVENTSUB_WS_URL;
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private async connect(url: string = this.wsUrl): Promise<void> {
    this.handlers?.onStatus?.({ state: this.backoffMs > 1000 ? 'reconnecting' : 'connecting' });
    this.token = await this.opts.getToken();
    if (!this.token) {
      this.handlers?.onStatus?.({ state: 'closed', reason: 'no twitch token' });
      return;
    }
    this.ids = await this.resolveIds(this.token);
    if (!this.ids) {
      this.handlers?.onStatus?.({ state: 'closed', reason: 'could not resolve twitch user id' });
      return;
    }

    const ws = new this.WebSocketImpl(url);
    this.ws = ws;
    ws.on('message', (data: WebSocket.RawData) => this.onData(data.toString()));
    ws.on('close', () => this.scheduleReconnect('socket closed'));
    ws.on('error', (err: Error) => this.scheduleReconnect(err.message));
  }

  private onData(raw: string): void {
    let envelope: EventSubEnvelope;
    try {
      envelope = JSON.parse(raw) as EventSubEnvelope;
    } catch {
      return;
    }
    const type = envelope.metadata?.message_type;
    if (type === 'session_welcome') {
      const sessionId = envelope.payload?.session?.id;
      if (sessionId) void this.subscribe(sessionId);
    } else if (type === 'session_reconnect') {
      const url = envelope.payload?.session?.reconnect_url;
      if (url) {
        this.ws?.close();
        void this.connect(url);
      }
    } else if (type === 'notification') {
      if (
        envelope.metadata?.subscription_type === 'channel.chat.message' &&
        envelope.payload?.event
      ) {
        this.backoffMs = 1000; // healthy traffic resets backoff
        this.handlers?.onMessage(eventSubToChatMessage(this.channel, envelope.payload.event));
      }
    } else if (type === 'revocation') {
      this.handlers?.onStatus?.({ state: 'closed', reason: 'subscription revoked' });
    }
  }

  private async subscribe(sessionId: string): Promise<void> {
    if (!this.token || !this.ids) return;
    try {
      const res = await this.fetchImpl(`${HELIX}/eventsub/subscriptions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'client-id': this.opts.clientId,
          'content-type': 'application/json',
        },
        body: JSON.stringify(
          buildChatSubscription(this.ids.broadcasterId, this.ids.userId, sessionId),
        ),
      });
      if (res.ok) this.handlers?.onStatus?.({ state: 'connected' });
      else
        this.handlers?.onStatus?.({ state: 'closed', reason: `subscribe failed (${res.status})` });
    } catch (err) {
      this.handlers?.onStatus?.({ state: 'reconnecting', reason: (err as Error).message });
    }
  }

  private async resolveIds(token: string): Promise<ResolvedIds | null> {
    const broadcasterId = await this.userId(token, this.channel);
    const userId = await this.userId(token, null); // the token's own user
    if (!broadcasterId || !userId) return null;
    return { broadcasterId, userId };
  }

  private async userId(token: string, login: string | null): Promise<string | null> {
    try {
      const url = login ? `${HELIX}/users?login=${encodeURIComponent(login)}` : `${HELIX}/users`;
      const res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, 'client-id': this.opts.clientId },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      return json.data?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) {
      this.handlers?.onStatus?.({ state: 'closed', reason });
      return;
    }
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    this.handlers?.onStatus?.({ state: 'reconnecting', reason });
    const delay = this.backoffMs + Math.random() * this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    setTimeout(() => {
      this.reconnectScheduled = false;
      if (!this.stopped) void this.connect();
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

interface EventSubEnvelope {
  metadata?: { message_type?: string; subscription_type?: string };
  payload?: {
    session?: { id?: string; reconnect_url?: string };
    event?: Record<string, unknown>;
  };
}

/** Build the Helix subscription request body for chat messages over WebSocket. */
export function buildChatSubscription(
  broadcasterUserId: string,
  userId: string,
  sessionId: string,
): Record<string, unknown> {
  return {
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: broadcasterUserId, user_id: userId },
    transport: { method: 'websocket', session_id: sessionId },
  };
}

/** Parse a `channel.chat.message` event payload into a normalized ChatMessage. */
export function eventSubToChatMessage(
  channel: string,
  event: Record<string, unknown>,
): ChatMessage {
  const message = (event['message'] as { text?: string } | undefined) ?? {};
  const cheer = event['cheer'] as { bits?: number } | undefined;
  const bits = typeof cheer?.bits === 'number' ? cheer.bits : undefined;
  const color = typeof event['color'] === 'string' && event['color'] ? event['color'] : undefined;
  return {
    id: (asString(event['message_id']) ?? randomId()) as string,
    platform: 'twitch',
    channel,
    author:
      asString(event['chatter_user_name']) ?? asString(event['chatter_user_login']) ?? 'unknown',
    authorId: asString(event['chatter_user_id']),
    text: typeof message.text === 'string' ? message.text : '',
    timestamp: Date.now(),
    bits,
    roles: rolesFromEventSubBadges(event['badges']),
    color,
  };
}

/** Map EventSub `badges` (array of { set_id }) to Glance chat roles. */
export function rolesFromEventSubBadges(badges: unknown): ChatRole[] {
  const roles: ChatRole[] = [];
  if (!Array.isArray(badges)) return roles;
  const sets = new Set(
    badges
      .map((b) => (b && typeof b === 'object' ? (b as { set_id?: unknown }).set_id : undefined))
      .filter((s): s is string => typeof s === 'string'),
  );
  if (sets.has('broadcaster')) roles.push('broadcaster');
  if (sets.has('moderator')) roles.push('moderator');
  if (sets.has('vip')) roles.push('vip');
  if (sets.has('subscriber')) roles.push('subscriber');
  if (sets.has('founder')) roles.push('founder');
  return roles;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

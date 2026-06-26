import WebSocket from 'ws';
import type { ChatMessage, ChatRole } from '@glance/core';
import type { AdapterHandlers, PlatformAdapter } from './adapter';

// Kick's public realtime chat rides on Pusher; reading is anonymous (no OAuth),
// mirroring the Twitch IRC reader. The chatroom id is resolved from the channel slug.
const KICK_PUSHER_KEY = '32cbd69e4b950bf97679';
const KICK_API = 'https://kick.com/api/v2';
const CHAT_EVENT = 'App\\Events\\ChatMessageEvent';

export interface KickOptions {
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  pusherKey?: string;
  /** Skip slug resolution when the chatroom id is already known (e.g. tests). */
  chatroomId?: number;
}

export class KickAdapter implements PlatformAdapter {
  readonly platform = 'kick' as const;
  readonly channel: string;

  private ws: WebSocket | null = null;
  private handlers: AdapterHandlers | null = null;
  private stopped = false;
  private chatroomId: number | null = null;
  private backoffMs = 1000;
  private reconnectScheduled = false;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly pusherKey: string;

  constructor(
    channel: string,
    private readonly opts: KickOptions = {},
  ) {
    this.channel = channel.replace(/^#/, '').toLowerCase();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.pusherKey = opts.pusherKey ?? KICK_PUSHER_KEY;
    this.chatroomId = opts.chatroomId ?? null;
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.handlers = handlers;
    this.stopped = false;
    handlers.onStatus?.({ state: 'connecting' });
    if (this.chatroomId === null) this.chatroomId = await this.resolveChatroomId();
    if (this.chatroomId === null) {
      handlers.onStatus?.({ state: 'closed', reason: 'could not resolve kick chatroom' });
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const url = `wss://ws-us2.pusher.com/app/${this.pusherKey}?protocol=7&client=glance&version=1.0&flash=false`;
    const ws = new this.WebSocketImpl(url);
    this.ws = ws;
    ws.on('open', () => {
      this.backoffMs = 1000;
    });
    ws.on('message', (data: WebSocket.RawData) => this.onData(data.toString()));
    ws.on('close', () => this.scheduleReconnect('socket closed'));
    ws.on('error', (err: Error) => this.scheduleReconnect(err.message));
  }

  private onData(raw: string): void {
    let env: { event?: string; data?: unknown };
    try {
      env = JSON.parse(raw) as { event?: string; data?: unknown };
    } catch {
      return;
    }
    if (env.event === 'pusher:connection_established') {
      this.subscribe();
      this.handlers?.onStatus?.({ state: 'connected' });
    } else if (env.event === 'pusher:ping') {
      try {
        this.ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      } catch {
        /* ignore */
      }
    } else if (env.event === CHAT_EVENT) {
      const data = typeof env.data === 'string' ? safeParse(env.data) : env.data;
      if (data && typeof data === 'object') {
        this.handlers?.onMessage(kickToChatMessage(this.channel, data as Record<string, unknown>));
      }
    }
  }

  private subscribe(): void {
    try {
      this.ws?.send(
        JSON.stringify({
          event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` },
        }),
      );
    } catch {
      /* ignore */
    }
  }

  private async resolveChatroomId(): Promise<number | null> {
    try {
      const res = await this.fetchImpl(`${KICK_API}/channels/${encodeURIComponent(this.channel)}`, {
        headers: { accept: 'application/json', 'user-agent': 'glance/1.0' },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { chatroom?: { id?: number } };
      return typeof json.chatroom?.id === 'number' ? json.chatroom.id : null;
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
      if (!this.stopped) this.connect();
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Parse a Kick `ChatMessageEvent` payload into a normalized ChatMessage. */
export function kickToChatMessage(channel: string, data: Record<string, unknown>): ChatMessage {
  const sender = (data['sender'] as Record<string, unknown> | undefined) ?? {};
  const identity = (sender['identity'] as Record<string, unknown> | undefined) ?? {};
  const color =
    typeof identity['color'] === 'string' && identity['color'] ? identity['color'] : undefined;
  return {
    id: asString(data['id']) ?? randomId(),
    platform: 'kick',
    channel,
    author: asString(sender['username']) ?? 'unknown',
    authorId: sender['id'] !== undefined ? String(sender['id']) : undefined,
    text: asString(data['content']) ?? '',
    timestamp: Date.now(),
    roles: rolesFromKick(identity['badges']),
    color,
  };
}

export function rolesFromKick(badges: unknown): ChatRole[] {
  const roles: ChatRole[] = [];
  if (!Array.isArray(badges)) return roles;
  const types = new Set(
    badges
      .map((b) => (b && typeof b === 'object' ? (b as { type?: unknown }).type : undefined))
      .filter((t): t is string => typeof t === 'string'),
  );
  if (types.has('broadcaster')) roles.push('broadcaster');
  if (types.has('moderator')) roles.push('moderator');
  if (types.has('vip')) roles.push('vip');
  if (types.has('subscriber')) roles.push('subscriber');
  if (types.has('founder')) roles.push('founder');
  return roles;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

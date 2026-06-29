import WebSocket from 'ws';
import type { ChatMessage, ChannelEvent, ChatRole } from '@glance/core';
import type { AdapterHandlers, PlatformAdapter } from './adapter';

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

/**
 * Reads a live Twitch chat anonymously over IRC-over-WebSocket.
 *
 * Anonymous read requires NO OAuth, API key or approval — we connect with a
 * `justinfan` nick, request IRCv3 tags, and parse PRIVMSG (chat) and USERNOTICE
 * (subs / raids / gifts) lines. For production scale you would swap this for
 * EventSub; the {@link PlatformAdapter} contract stays identical.
 */
export class TwitchAdapter implements PlatformAdapter {
  readonly platform = 'twitch' as const;
  readonly channel: string;

  private ws: WebSocket | null = null;
  private handlers: AdapterHandlers | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private reconnectScheduled = false;

  constructor(channel: string) {
    this.channel = channel.replace(/^#/, '').toLowerCase();
  }

  start(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    this.handlers?.onStatus?.({ state: this.backoffMs > 1000 ? 'reconnecting' : 'connecting' });
    const ws = new WebSocket(TWITCH_IRC_URL);
    this.ws = ws;

    ws.on('open', () => {
      const nick = `justinfan${Math.floor(Math.random() * 80000) + 1000}`;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send(`NICK ${nick}`);
      ws.send(`JOIN #${this.channel}`);
      this.backoffMs = 1000;
      this.handlers?.onStatus?.({ state: 'connected' });
    });
    ws.on('message', (data: WebSocket.RawData) => this.onData(data.toString()));
    ws.on('close', () => this.scheduleReconnect('socket closed'));
    ws.on('error', (err: Error) => this.scheduleReconnect(err.message));
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) {
      this.handlers?.onStatus?.({ state: 'closed', reason });
      return;
    }
    // Single-flight: a socket failure fires both 'error' and 'close' — don't
    // schedule two overlapping reconnects.
    if (this.reconnectScheduled) return;
    this.reconnectScheduled = true;
    this.handlers?.onStatus?.({ state: 'reconnecting', reason });
    // Full jitter so thousands of adapters don't stampede Twitch in lockstep.
    const delay = this.backoffMs + Math.random() * this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    setTimeout(() => {
      this.reconnectScheduled = false;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private onData(raw: string): void {
    for (const line of raw.split('\r\n')) {
      if (line.length === 0) continue;
      if (line.startsWith('PING')) {
        this.ws?.send('PONG :tmi.twitch.tv');
        continue;
      }
      const irc = parseIrcLine(line);
      if (irc.command === 'PRIVMSG') {
        this.handlers?.onMessage(toChatMessage(this.channel, irc));
      } else if (irc.command === 'USERNOTICE') {
        const event = toChannelEvent(this.channel, irc);
        if (event) this.handlers?.onEvent(event);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// IRC parsing (exported for unit testing)
// ---------------------------------------------------------------------------

export interface IrcMessage {
  tags: Record<string, string>;
  prefix: string | null;
  command: string;
  params: string[];
}

export function parseIrcLine(line: string): IrcMessage {
  let rest = line;
  const tags: Record<string, string> = {};

  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    const tagStr = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    for (const pair of tagStr.split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) tags[pair] = '';
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
  }

  let prefix: string | null = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }

  let trailing: string | null = null;
  const ti = rest.indexOf(' :');
  if (ti !== -1) {
    trailing = rest.slice(ti + 2);
    rest = rest.slice(0, ti);
  }

  const parts = rest.split(' ').filter((p) => p.length > 0);
  const command = parts.shift() ?? '';
  if (trailing !== null) parts.push(trailing);
  return { tags, prefix, command, params: parts };
}

function unescapeTag(v: string): string {
  return v
    .replace(/\\s/g, ' ')
    .replace(/\\:/g, ';')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}

function nickFromPrefix(prefix: string | null): string | undefined {
  if (!prefix) return undefined;
  const bang = prefix.indexOf('!');
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

function rolesFromTags(tags: Record<string, string>): ChatRole[] {
  const roles: ChatRole[] = [];
  const badges = tags['badges'] ?? '';
  if (badges.includes('broadcaster/')) roles.push('broadcaster');
  if (tags['mod'] === '1' || badges.includes('moderator/')) roles.push('moderator');
  if (badges.includes('vip/')) roles.push('vip');
  if (tags['subscriber'] === '1' || badges.includes('subscriber/')) roles.push('subscriber');
  if (badges.includes('founder/')) roles.push('founder');
  return roles;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function toChatMessage(channel: string, irc: IrcMessage): ChatMessage {
  const tags = irc.tags;
  return {
    id: tags['id'] || randomId(),
    platform: 'twitch',
    channel,
    author: tags['display-name'] || nickFromPrefix(irc.prefix) || 'unknown',
    authorId: tags['user-id'],
    text: irc.params[1] ?? '',
    timestamp: Date.now(),
    bits: num(tags['bits']),
    roles: rolesFromTags(tags),
    color: tags['color'] || undefined,
  };
}

export function toChannelEvent(channel: string, irc: IrcMessage): ChannelEvent | null {
  const tags = irc.tags;
  const msgId = tags['msg-id'] ?? '';
  const system = (tags['system-msg'] ?? '').trim();
  const who = tags['display-name'];
  const base = {
    id: tags['id'] || randomId(),
    platform: 'twitch' as const,
    channel,
    author: who,
    timestamp: Date.now(),
  };

  switch (msgId) {
    case 'sub':
      return {
        ...base,
        kind: 'subscription',
        summary: system || `${who} subscribed`,
        magnitude: 1,
      };
    case 'resub': {
      const months = num(tags['msg-param-cumulative-months']) ?? num(tags['msg-param-months']) ?? 1;
      return {
        ...base,
        kind: 'resub',
        summary: system || `${who} resubscribed (${months} mo)`,
        magnitude: months,
      };
    }
    case 'subgift':
    case 'anonsubgift':
      return {
        ...base,
        kind: 'gift_subs',
        summary:
          system ||
          `${who} gifted a sub to ${tags['msg-param-recipient-display-name'] ?? 'someone'}`,
        magnitude: 1,
      };
    case 'submysterygift': {
      const count = num(tags['msg-param-mass-gift-count']) ?? 1;
      return {
        ...base,
        kind: 'gift_subs',
        summary: system || `${who} gifted ${count} subs`,
        magnitude: count,
      };
    }
    case 'raid': {
      const viewers = num(tags['msg-param-viewerCount']) ?? 0;
      const from = tags['msg-param-displayName'] ?? who;
      return {
        ...base,
        kind: 'raid',
        summary: system || `raid: ${viewers} viewers from ${from}`,
        author: from,
        magnitude: viewers,
      };
    }
    case 'announcement':
      return { ...base, kind: 'announcement', summary: irc.params[1] ?? system };
    default:
      return null;
  }
}

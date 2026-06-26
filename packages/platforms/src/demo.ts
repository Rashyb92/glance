import type { ChatMessage, ChannelEvent, ChatRole } from '@glance/core';
import type { AdapterHandlers, PlatformAdapter } from './adapter';

/**
 * A synthetic chat source. It implements the exact same {@link PlatformAdapter}
 * contract as the real Twitch adapter, so it is both (a) a zero-dependency way to
 * see the HUD come alive on a quiet channel and (b) the reference example for how
 * a future Kick / YouTube adapter should look.
 */
const USERS = [
  'mara_plays', 'grumpycat', 'devon_irl', 'liluzi', 'kayohh', 'no_scope_nick',
  'pixelpip', 'quietstorm', 'bigtuna', 'sunny_side', 'wanderlust', 'frostbyte',
  'echo_22', 'novaaa', 'glitchking', 'mintchoc',
];
const CHATTER = [
  'this stream is so good', 'lmao', 'W streamer', 'first time here, love it',
  'the vibes are immaculate', 'POG', 'that was clean', 'hi from germany',
  'this city looks amazing', 'i been here 3 hours send help', 'bro the sunset',
  'LULW', 'sheesh', 'no wayyy', 'real', 'chat is wild today',
];
const QUESTIONS = [
  'what time do you go live tomorrow?', 'are you doing the marathon this weekend?',
  'how long have you been streaming?', 'can you show the map again?',
  'what camera are you using?', 'is this your first time in tokyo?',
];
const DONO_MESSAGES = [
  'amazing stream!', 'love your content, keep it up', 'this made my day', 'take my bits king',
];
const TREND_PHRASES = ['do the food challenge', 'say hi to chat', 'show the doggo', 'order the ramen'];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function rid(): string {
  return Math.random().toString(36).slice(2);
}

export class DemoAdapter implements PlatformAdapter {
  readonly platform = 'demo' as const;
  readonly channel: string;

  private timers: NodeJS.Timeout[] = [];
  private handlers: AdapterHandlers | null = null;

  constructor(channel = 'glance_demo') {
    this.channel = channel;
  }

  start(handlers: AdapterHandlers): void {
    this.handlers = handlers;
    handlers.onStatus?.({ state: 'connected' });
    this.timers.push(setInterval(() => this.chatter(), 850));
    this.timers.push(setInterval(() => this.emit(pick(QUESTIONS)), 6500));
    this.timers.push(setInterval(() => this.donation(), 11000));
    this.timers.push(setInterval(() => this.trend(), 17000));
    this.timers.push(setInterval(() => this.event(), 23000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private emit(text: string, extra: Partial<ChatMessage> = {}): void {
    const message: ChatMessage = {
      id: rid(),
      platform: 'demo',
      channel: this.channel,
      author: pick(USERS),
      text,
      timestamp: Date.now(),
      synthetic: true,
      ...extra,
    };
    this.handlers?.onMessage(message);
  }

  private chatter(): void {
    this.emit(pick(CHATTER));
  }

  private donation(): void {
    const bits = pick([100, 200, 300, 500, 1000]);
    const roles: ChatRole[] = ['subscriber'];
    this.emit(pick(DONO_MESSAGES), { bits, roles });
  }

  private trend(): void {
    const phrase = pick(TREND_PHRASES);
    const total = 4 + Math.floor(Math.random() * 3);
    let sent = 0;
    const burst = setInterval(() => {
      this.emit(phrase);
      if (++sent >= total) clearInterval(burst);
    }, 220);
    this.timers.push(burst);
  }

  private event(): void {
    const raid = Math.random() < 0.5;
    const magnitude = raid ? 120 + Math.floor(Math.random() * 900) : 1;
    const event: ChannelEvent = {
      id: rid(),
      platform: 'demo',
      channel: this.channel,
      kind: raid ? 'raid' : 'subscription',
      summary: raid
        ? `raid: ${magnitude} viewers from ${pick(USERS)}`
        : `${pick(USERS)} just subscribed!`,
      author: pick(USERS),
      magnitude,
      timestamp: Date.now(),
      synthetic: true,
    };
    this.handlers?.onEvent(event);
  }
}

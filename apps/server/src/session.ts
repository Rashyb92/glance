import { DEFAULT_ENGINE_SETTINGS, SessionRecorder, StatsAggregator } from '@glance/core';
import type {
  ChannelEvent,
  ChatMessage,
  ChatSummary,
  EngineSettings,
  ScoredMessage,
  ServerMessage,
  SessionState,
} from '@glance/core';
import { DemoAdapter, TwitchAdapter } from '@glance/platforms';
import type { AdapterHandlers, PlatformAdapter } from '@glance/platforms';
import type { AIProvider } from '@glance/ai';
import { GlanceEngine } from './engine';
import type { Storage } from './storage';

export interface SessionDeps {
  ai: AIProvider;
  storage: Storage;
  log: (message: string) => void;
}

/**
 * Owns the live pipeline for one channel and lets it be (re)built at runtime.
 * `connect()` tears down any previous session (archiving it via the recorder) and
 * stands up a fresh engine, stats aggregator, recorder and adapter set.
 */
export class SessionController {
  private engine: GlanceEngine | null = null;
  private stats: StatsAggregator | null = null;
  private recorder: SessionRecorder | null = null;
  private adapters: PlatformAdapter[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  private state: SessionState = {
    channel: null,
    demo: true,
    connected: false,
    platform: null,
    since: null,
  };
  private broadcast: (message: ServerMessage) => void = () => {};
  private settings: EngineSettings = DEFAULT_ENGINE_SETTINGS;

  constructor(private readonly deps: SessionDeps) {}

  /** Wire up the outbound transport once the gateway exists. */
  setBroadcast(fn: (message: ServerMessage) => void): void {
    this.broadcast = fn;
  }

  /** Apply engine settings live, and remember them for the next connect(). */
  applySettings(settings: EngineSettings): void {
    this.settings = settings;
    this.engine?.setKeywords(settings.keywords);
    this.engine?.setSummaryInterval(settings.summaryIntervalMs);
    this.stats?.setThreshold(settings.surfaceThreshold);
  }

  getState(): SessionState {
    return this.state;
  }

  snapshot(limit = 40): ScoredMessage[] {
    return this.engine?.snapshot(limit) ?? [];
  }

  connect(channel: string, demo: boolean): SessionState {
    this.teardown();
    const ch = channel.trim().replace(/^#/, '').toLowerCase();
    const label = ch || 'demo';
    const platform = ch ? 'twitch' : 'demo';

    this.recorder = new SessionRecorder(
      `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      label,
      platform,
    );
    this.stats = new StatsAggregator(label);
    this.stats.setThreshold(this.settings.surfaceThreshold);
    this.engine = new GlanceEngine({
      channel: label,
      broadcaster: ch || undefined,
      ai: this.deps.ai,
      keywords: this.settings.keywords,
      summaryIntervalMs: this.settings.summaryIntervalMs,
      onItem: (item) => {
        if (item.type === 'message') {
          this.stats?.ingestMessage(item.data);
          this.recorder?.recordMessage(item.data);
        } else if (item.type === 'event') {
          this.stats?.ingestEvent(item.data);
          this.recorder?.recordEvent(item.data);
        } else if (item.type === 'summary') {
          this.recorder?.recordSummary(item.data);
        }
        this.broadcast(item);
      },
    });
    this.engine.start();
    this.statsTimer = setInterval(() => {
      if (!this.stats) return;
      const snap = this.stats.snapshot();
      this.recorder?.observeChatters(snap.chatters);
      this.broadcast({ type: 'stats', data: snap });
    }, 2000);

    this.adapters = [];
    if (ch) this.adapters.push(new TwitchAdapter(ch));
    if (demo || this.adapters.length === 0) this.adapters.push(new DemoAdapter(ch || 'glance_demo'));
    for (const adapter of this.adapters) {
      const handlers: AdapterHandlers = {
        onMessage: (m: ChatMessage) => this.engine?.ingestMessage(m),
        onEvent: (e: ChannelEvent) => this.engine?.ingestEvent(e),
        onStatus: (s) => {
          const extra = 'reason' in s && s.reason ? ` (${s.reason})` : '';
          this.deps.log(`[${adapter.platform}:${adapter.channel}] ${s.state}${extra}`);
          if (s.state === 'connected') this.markConnected();
        },
      };
      adapter.start(handlers);
    }

    this.state = { channel: ch || null, demo, connected: false, platform, since: Date.now() };
    this.broadcast({ type: 'session', data: this.state });
    return this.state;
  }

  disconnect(): SessionState {
    this.teardown();
    this.state = {
      channel: null,
      demo: this.state.demo,
      connected: false,
      platform: null,
      since: null,
    };
    this.broadcast({ type: 'session', data: this.state });
    return this.state;
  }

  shutdown(): void {
    this.teardown();
  }

  private markConnected(): void {
    if (!this.state.connected) {
      this.state = { ...this.state, connected: true };
      this.broadcast({ type: 'session', data: this.state });
    }
  }

  /** Finalize the outgoing session: AI recap (best-effort) + durable archive. */
  private persist(recorder: SessionRecorder): void {
    const endedAt = Date.now();
    const top = recorder.topMoments(8);
    void (async () => {
      let recap: ChatSummary | null = null;
      if (top.length > 0) {
        try {
          recap = await this.deps.ai.summarize({ channel: recorder.channel, recent: top });
        } catch {
          recap = null;
        }
      }
      try {
        const detail = recorder.finalize(endedAt, recap);
        this.deps.storage.saveSession(detail);
        this.deps.log(
          `session archived: ${detail.channel} · ${detail.durationSec}s · ${detail.messages} msgs`,
        );
      } catch {
        this.deps.log('session archive failed');
      }
    })();
  }

  private teardown(): void {
    if (this.recorder?.hasContent()) this.persist(this.recorder);
    this.recorder = null;
    for (const adapter of this.adapters) void adapter.stop();
    this.adapters = [];
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.engine?.stop();
    this.engine = null;
    this.stats = null;
  }
}

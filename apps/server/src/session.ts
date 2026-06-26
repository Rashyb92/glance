import { randomUUID } from 'node:crypto';
import { DEFAULT_ENGINE_SETTINGS, SessionRecorder, StatsAggregator } from '@glance/core';
import type {
  ChannelEvent,
  ChatMessage,
  ChatSummary,
  EngineSettings,
  Platform,
  ScoredMessage,
  ServerMessage,
  SessionState,
} from '@glance/core';
import { DemoAdapter, KickAdapter, TwitchAdapter } from '@glance/platforms';
import type { AdapterHandlers, PlatformAdapter } from '@glance/platforms';
import type { AIProvider } from '@glance/ai';
import { GlanceEngine } from './engine';
import type { Storage } from './storage';
import { metrics } from './metrics';

export interface SessionDeps {
  ai: AIProvider;
  storage: Storage;
  log: (message: string) => void;
  /** Gate for the AI usage cap — returns false when the daily budget is spent. */
  canUseAi?: () => boolean;
  /** Optional factory for a live (EventSub) Twitch adapter; null → fall back to IRC. */
  makeTwitchAdapter?: (channel: string) => PlatformAdapter | null;
  /** Optional factory for a YouTube adapter (needs a linked token); null → demo. */
  makeYouTubeAdapter?: (channel: string) => PlatformAdapter | null;
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
  private priorityTimer: NodeJS.Timeout | null = null;
  private prioritizing = false;
  private aiPriorities = true;
  private readonly persisting = new Set<Promise<void>>();
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
    this.aiPriorities = settings.aiPriorities;
    this.engine?.setKeywords(settings.keywords);
    this.engine?.setSummaryInterval(settings.summaryIntervalMs);
    this.engine?.setSummariesEnabled(settings.aiSummaries);
    this.engine?.setModeration(settings.moderation, settings.moderationSensitivity);
    this.stats?.setThreshold(settings.surfaceThreshold);
  }

  getState(): SessionState {
    return this.state;
  }

  snapshot(limit = 40): ScoredMessage[] {
    return this.engine?.snapshot(limit) ?? [];
  }

  connect(channel: string, demo: boolean, source: Platform = 'twitch'): SessionState {
    this.teardown();
    let ch = channel.trim().replace(/^#/, '').toLowerCase();
    // Validate per platform (Twitch logins are stricter than Kick/YouTube slugs);
    // reject garbage rather than reconnect-looping on it.
    const valid = source === 'twitch' ? /^[a-z0-9_]{3,25}$/ : /^[a-z0-9_.-]{1,60}$/;
    if (ch && !valid.test(ch)) {
      this.deps.log(`rejected invalid channel: ${ch.slice(0, 40)}`);
      ch = '';
    }
    // Pick the live adapter up-front so the session is labelled with the real source.
    const live = ch ? this.buildAdapter(source, ch) : null;
    const label = ch || 'demo';
    const platform: Platform = live ? source : 'demo';

    this.recorder = new SessionRecorder(
      // Time prefix keeps archives debuggable; crypto suffix makes IDs unguessable.
      `${label}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      label,
      platform,
      Date.now(),
      !this.settings.storeMessageText, // privacy mode → omit raw text from the archive
    );
    this.stats = new StatsAggregator(label);
    this.stats.setThreshold(this.settings.surfaceThreshold);
    this.engine = new GlanceEngine({
      channel: label,
      broadcaster: ch || undefined,
      ai: this.deps.ai,
      keywords: this.settings.keywords,
      summaryIntervalMs: this.settings.summaryIntervalMs,
      canUseAi: this.deps.canUseAi,
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
    this.engine.setSummariesEnabled(this.settings.aiSummaries);
    this.engine.setModeration(this.settings.moderation, this.settings.moderationSensitivity);
    this.aiPriorities = this.settings.aiPriorities;
    this.statsTimer = setInterval(() => {
      if (!this.stats) return;
      const snap = this.stats.snapshot();
      this.recorder?.observeChatters(snap.chatters);
      this.broadcast({ type: 'stats', data: snap });
    }, 2000);
    this.priorityTimer = setInterval(() => void this.emitPriorities(), 9000);

    this.adapters = [];
    if (live) this.adapters.push(live);
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
    metrics.inc('glance_sessions_started_total');
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

  /** Await any in-flight session archives — used for graceful shutdown. */
  async drain(timeoutMs = 5000): Promise<void> {
    if (this.persisting.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.persisting]),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
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
    const task = (async () => {
      let recap: ChatSummary | null = null;
      if (top.length > 0 && (!this.deps.canUseAi || this.deps.canUseAi())) {
        try {
          recap = await this.deps.ai.summarize({ channel: recorder.channel, recent: top });
        } catch (err) {
          metrics.inc('glance_ai_errors_total');
          this.deps.log(`recap failed: ${(err as Error).message}`);
          recap = null;
        }
      }
      try {
        const detail = recorder.finalize(endedAt, recap);
        this.deps.storage.saveSession(detail);
        metrics.inc('glance_sessions_archived_total');
        this.deps.log(
          `session archived: ${detail.channel} · ${detail.durationSec}s · ${detail.messages} msgs`,
        );
      } catch (err) {
        this.deps.log(`session archive failed: ${(err as Error).message}`);
      }
    })();
    this.persisting.add(task);
    void task.finally(() => this.persisting.delete(task));
  }

  /** Re-rank recent high-salience candidates via the AI provider and broadcast. */
  private async emitPriorities(): Promise<void> {
    if (!this.aiPriorities || !this.engine || this.prioritizing) return;
    const candidates = this.engine
      .snapshot(50)
      .filter((m) => m.score >= this.settings.surfaceThreshold);
    if (candidates.length === 0) return;
    if (this.deps.canUseAi && !this.deps.canUseAi()) return; // daily AI cap reached
    this.prioritizing = true;
    try {
      const priorities = await this.deps.ai.prioritize({
        channel: this.state.channel ?? 'demo',
        broadcaster: this.state.channel ?? undefined,
        candidates,
      });
      if (priorities.length > 0) this.broadcast({ type: 'priorities', data: priorities });
    } catch {
      metrics.inc('glance_ai_errors_total');
    } finally {
      this.prioritizing = false;
    }
  }

  /** Construct the live adapter for a platform, or null if it can't read live. */
  private buildAdapter(source: Platform, ch: string): PlatformAdapter | null {
    if (source === 'kick') return new KickAdapter(ch);
    if (source === 'youtube') return this.deps.makeYouTubeAdapter?.(ch) ?? null;
    return this.deps.makeTwitchAdapter?.(ch) ?? new TwitchAdapter(ch);
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
    if (this.priorityTimer) {
      clearInterval(this.priorityTimer);
      this.priorityTimer = null;
    }
    this.engine?.stop();
    this.engine = null;
    this.stats = null;
  }
}

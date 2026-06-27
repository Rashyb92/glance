import { randomUUID } from 'node:crypto';
import { DEFAULT_ENGINE_SETTINGS, PaceGate, SessionRecorder, StatsAggregator } from '@glance/core';
import type {
  ChannelEvent,
  ChannelRef,
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
import type { ClipResult } from './clip';

export interface SessionDeps {
  ai: AIProvider;
  storage: Storage;
  log: (message: string) => void;
  /** Gate for the AI usage cap — returns false when the daily budget is spent. */
  canUseAi?: () => boolean | Promise<boolean>;
  /** Optional factory for a live (EventSub) Twitch adapter; null → fall back to IRC. */
  makeTwitchAdapter?: (channel: string) => PlatformAdapter | null;
  /** Optional factory for a YouTube adapter (needs a linked token); null → demo. */
  makeYouTubeAdapter?: (channel: string) => PlatformAdapter | null;
  /** Optional live viewer-count fetcher per platform. */
  fetchViewers?: (platform: Platform, channel: string) => Promise<number | null>;
  /** Optional platform clip creator (Twitch Helix), fired by "clip that" voice marks. */
  clip?: () => Promise<ClipResult>;
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
  private pace = new PaceGate();
  private adapters: PlatformAdapter[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  private priorityTimer: NodeJS.Timeout | null = null;
  private viewerTimer: NodeJS.Timeout | null = null;
  private prioritizing = false;
  private aiPriorities = true;
  private readonly persisting = new Set<Promise<void>>();
  private state: SessionState = {
    channel: null,
    demo: true,
    connected: false,
    platform: null,
    since: null,
    viewers: null,
    channels: [],
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
    this.pace.setPace(settings.pace);
  }

  getState(): SessionState {
    return this.state;
  }

  snapshot(limit = 40): ScoredMessage[] {
    return this.engine?.snapshot(limit) ?? [];
  }

  connect(channel: string, demo: boolean, source: Platform = 'twitch'): SessionState {
    return this.connectMany(channel.trim() ? [{ platform: source, channel }] : [], demo);
  }

  /**
   * Connect one or more (platform, channel) sources into a single merged session.
   * Every adapter feeds the same engine / stats / recorder, so several simultaneous
   * streams — e.g. a simulcast to Twitch + YouTube + Kick — become one unified,
   * salience-ranked chat. Falls back to the demo feed when no live source is given.
   */
  connectMany(sources: ChannelRef[], demo: boolean): SessionState {
    this.teardown();

    // Validate + normalize each requested source; build a live adapter per valid one.
    // (Twitch logins are stricter than Kick/YouTube slugs; reject garbage rather than
    // reconnect-loop on it.)
    const live: Array<{ ref: ChannelRef; adapter: PlatformAdapter }> = [];
    for (const src of sources) {
      const ch = src.channel.trim().replace(/^#/, '').toLowerCase();
      const valid = src.platform === 'twitch' ? /^[a-z0-9_]{3,25}$/ : /^[a-z0-9_.-]{1,60}$/;
      if (!ch || !valid.test(ch)) {
        if (src.channel.trim()) this.deps.log(`rejected invalid channel: ${src.channel.slice(0, 40)}`);
        continue;
      }
      const adapter = this.buildAdapter(src.platform, ch);
      if (adapter) live.push({ ref: { platform: src.platform, channel: ch }, adapter });
    }

    const channels = live.map((l) => l.ref);
    const primary = channels[0] ?? null;
    const label = primary?.channel ?? 'demo';
    const platform: Platform = primary?.platform ?? 'demo';

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
    this.pace = new PaceGate(this.settings.pace);
    this.engine = new GlanceEngine({
      channel: label,
      broadcaster: primary?.channel ?? undefined,
      ai: this.deps.ai,
      keywords: this.settings.keywords,
      summaryIntervalMs: this.settings.summaryIntervalMs,
      canUseAi: this.deps.canUseAi,
      onItem: (item) => {
        if (item.type === 'message') {
          this.stats?.ingestMessage(item.data);
          this.recorder?.recordMessage(item.data);
          // Pace throttles only the live feed — stats + recorder above always see it.
          if (!this.pace.allow(item.data.score, Date.now())) return;
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
    this.viewerTimer = setInterval(() => void this.pollViewers(), 20000);
    void this.pollViewers();

    this.adapters = live.map((l) => l.adapter);
    if (demo || this.adapters.length === 0) {
      this.adapters.push(new DemoAdapter(label === 'demo' ? 'glance_demo' : label));
    }
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

    this.state = {
      channel: primary?.channel ?? null,
      demo,
      connected: false,
      platform,
      since: Date.now(),
      viewers: null,
      channels,
    };
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
      viewers: null,
      channels: [],
    };
    this.broadcast({ type: 'session', data: this.state });
    return this.state;
  }

  /**
   * Flag the current moment in the session record (voice "clip that"). When the
   * channel is on Twitch and a clipper is configured, also create a real Twitch
   * clip and record its link beside the marker. Returns the clip URL if one was made.
   */
  async mark(): Promise<{ clipUrl?: string }> {
    const rec = this.recorder;
    rec?.recordMarker('creator mark');
    if (!this.deps.clip || this.state.platform !== 'twitch') return {};
    const result = await this.deps.clip();
    if (!result.ok || !result.url) return {};
    // The session can end while the clip is being created; only record if still live.
    if (this.recorder === rec) rec?.recordMarker(`clip: ${result.url}`);
    return { clipUrl: result.url };
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
      const aiAllowed = !this.deps.canUseAi || (await this.deps.canUseAi());
      if (top.length > 0 && aiAllowed) {
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
    if (this.deps.canUseAi && !(await this.deps.canUseAi())) return; // daily AI cap reached
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

  /** Poll each platform for live viewer counts, summed across channels, broadcast on change. */
  private async pollViewers(): Promise<void> {
    const { channels, demo } = this.state;
    let viewers: number | null = null;
    if (demo || channels.length === 0) {
      // Simulated for the demo feed so dev shows a live-looking "watching" number.
      const chatters = this.stats?.snapshot().chatters ?? 5;
      viewers = Math.max(0, Math.round((chatters + 4) * 11 + (Math.random() - 0.5) * 24));
    } else if (this.deps.fetchViewers) {
      const fetchViewers = this.deps.fetchViewers;
      const counts = await Promise.all(channels.map((c) => fetchViewers(c.platform, c.channel)));
      const known = counts.filter((n): n is number => n !== null);
      // Sum the platforms that reported; null only when none did.
      viewers = known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
    }
    if (viewers !== this.state.viewers) {
      this.state = { ...this.state, viewers };
      this.broadcast({ type: 'session', data: this.state });
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
    if (this.viewerTimer) {
      clearInterval(this.viewerTimer);
      this.viewerTimer = null;
    }
    this.engine?.stop();
    this.engine = null;
    this.stats = null;
  }
}

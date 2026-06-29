import {
  aggregateSessions,
  applyPlanLimits,
  isTeamRole,
  PLANS,
  type AnalyticsReport,
  type ChannelRef,
  type EngineSettings,
  type Platform,
  type PlanId,
  type ScoredMessage,
  type SessionDetail,
  type SessionState,
  type SessionSummary,
  type TeamMember,
} from '@glance/core';
import type { AIProvider } from '@glance/ai';
import { TwitchEventSubAdapter, YouTubeAdapter, type PlatformAdapter } from '@glance/platforms';
import { SessionController } from './session';
import { SettingsService, type SettingsStore } from './settings-store';
import type { Storage } from './storage';
import type { Bus } from './bus';
import type { KvStore } from './kv';
import { AiUsageMeter, type UsageMeter } from './ai-usage';
import type { TeamStore } from './team-store';
import type { PushStore, PushSubscription } from './push-store';
import { kickViewers, twitchViewers, youtubeViewers } from './viewers';
import { createTwitchClip } from './clip';
import { logger } from './logger';
import { metrics } from './metrics';
import { MemberDenylist } from './member-denylist';
import { SessionStore } from './session-store';
import type { ProductAnalytics } from './analytics/product-analytics';

interface Tenant {
  id: string;
  controller: SessionController;
  settings: SettingsService;
  storage: Storage;
  /** Last time this tenant was accessed — drives idle eviction. */
  lastTouch: number;
}

/** Resolves a tenant's billing plan. The EntitlementStore implements this; when no
 *  billing is wired the Hub defaults to `pro` (self-host / dev runs ungated). */
export interface EntitlementResolver {
  getPlan(tenant: string): PlanId;
  /** Optionally warm a tenant's plan from a durable store before its limits are applied. */
  hydrate?(tenant: string): Promise<void>;
}

/** Read-only operator view of a tenant for the admin/support console. No message content. */
export interface AdminSnapshot {
  tenant: string;
  /** Was the tenant already resident in memory before this lookup (vs. cold in the durable store)? */
  loaded: boolean;
  plan: PlanId;
  connected: boolean;
  /** Live sources as `platform:channel`, if a session is running. */
  channels: string[];
  viewers: number | null;
  /** AI calls consumed today, or null when the meter can't report without consuming (Redis mode). */
  aiUsedToday: number | null;
  aiCapPerDay: number;
  /** Archived session count — null when the tenant isn't resident (not materialized for a read). */
  archives: number | null;
  teamMembers: number;
  pushDevices: number;
  settings: { surfaceThreshold: number; retentionDays: number; storeMessageText: boolean } | null;
}

export interface HubDeps {
  ai: AIProvider;
  bus: Bus;
  makeStorage: (tenant: string) => Storage;
  makeSettingsStore: (tenant: string) => SettingsStore;
  entitlements?: EntitlementResolver;
  /** When set, tenants with a linked Twitch token read chat via EventSub (not IRC). */
  twitchLink?: {
    clientId: string;
    hasToken: (tenant: string) => boolean;
    getToken: (tenant: string) => Promise<string | null>;
    hydrate?: (tenant: string) => Promise<void>;
  };
  /** When set, tenants with a linked YouTube token read live chat via the API. */
  youtubeLink?: {
    hasToken: (tenant: string) => boolean;
    getToken: (tenant: string) => Promise<string | null>;
    hydrate?: (tenant: string) => Promise<void>;
  };
  /** Team roster store (gated to plans with `teamManagement`). */
  team?: TeamStore;
  /** Device registry for push notifications (wearables / phone companion). */
  push?: PushStore;
  /** AI usage meter — defaults to in-memory; pass a RedisUsageMeter for multi-instance. */
  usage?: UsageMeter;
  /** Durable KV (Postgres). When set, the Hub warms each tenant's stores on load and persists
   *  member revocations so a force-logout survives a restart / tenant migration. */
  kv?: KvStore;
  /** Owner-session revocation store — share the same instance with the AuthService so logout /
   *  revoke-all and the gateway's session check operate on one state. Defaults to one from `kv`. */
  sessions?: SessionStore;
  /** Publish a revocation onto the cross-instance control channel (Redis). When set, member
   *  revocations broadcast to the fleet so non-sticky deployments revoke everywhere instantly. */
  controlPublish?: (msg: string) => void;
  /** Privacy-respecting funnel analytics — records the `activated` (first connect) milestone. */
  analytics?: ProductAnalytics;
}

/**
 * Owns all tenants. Each tenant gets its own isolated pipeline (controller +
 * settings + storage); broadcasts are published to the {@link Bus} keyed by tenant.
 * Plan entitlements are enforced centrally here: settings are clamped with
 * {@link applyPlanLimits}, and AI calls are metered against the plan's daily cap.
 */
export class Hub {
  private readonly tenants = new Map<string, Tenant>();
  private readonly usage: UsageMeter;
  private readonly denylist: MemberDenylist;
  private readonly sessions: SessionStore;

  constructor(private readonly deps: HubDeps) {
    this.usage = deps.usage ?? new AiUsageMeter();
    this.denylist = new MemberDenylist(deps.kv, deps.controlPublish);
    this.sessions = deps.sessions ?? new SessionStore(deps.kv);
    metrics.gauge('glance_tenants', () => this.tenants.size);
  }

  getSnapshot(tenant: string): ScoredMessage[] {
    return this.tenant(tenant).controller.snapshot(40);
  }
  getSession(tenant: string): SessionState {
    return this.tenant(tenant).controller.getState();
  }
  getSettings(tenant: string): EngineSettings {
    return applyPlanLimits(this.tenant(tenant).settings.get(), this.planId(tenant));
  }
  connect(
    tenant: string,
    channel: string,
    demo: boolean,
    source: Platform = 'twitch',
  ): SessionState {
    this.deps.analytics?.reach(tenant, 'activated');
    return this.tenant(tenant).controller.connect(channel, demo, source);
  }
  /**
   * Connect several sources at once into one merged feed (unified multi-channel chat),
   * clamped to the tenant's plan cap — this is where `maxConcurrentSessions` is enforced.
   */
  connectMany(tenant: string, sources: ChannelRef[], demo: boolean): SessionState {
    this.deps.analytics?.reach(tenant, 'activated');
    const cap = Math.max(1, PLANS[this.planId(tenant)].limits.maxConcurrentSessions);
    return this.tenant(tenant).controller.connectMany(sources.slice(0, cap), demo);
  }
  disconnect(tenant: string): SessionState {
    return this.tenant(tenant).controller.disconnect();
  }
  mark(tenant: string): Promise<{ clipUrl?: string }> {
    return this.tenant(tenant).controller.mark();
  }
  updateSettings(tenant: string, patch: unknown): EngineSettings {
    const next = this.tenant(tenant).settings.update(patch);
    return applyPlanLimits(next, this.planId(tenant));
  }
  listSessions(tenant: string): SessionSummary[] {
    return this.tenant(tenant).storage.listSessions();
  }
  getReplay(tenant: string, id: string): SessionDetail | null {
    return this.tenant(tenant).storage.getSession(id);
  }
  deleteReplay(tenant: string, id: string): void {
    this.tenant(tenant).storage.deleteSession(id);
  }
  exportAll(tenant: string): SessionDetail[] {
    return this.tenant(tenant).storage.exportAll();
  }
  deleteByChannel(tenant: string, channel: string): number {
    return this.tenant(tenant).storage.deleteByChannel(channel);
  }
  /** Scrub a chatter's attributed content from this tenant's archives (DSAR by author id). */
  deleteByAuthor(tenant: string, author: string): number {
    return this.tenant(tenant).storage.deleteByAuthor(author);
  }
  /** Erase all of this tenant's session archives ("delete my replay history"). */
  eraseSessions(tenant: string): number {
    return this.tenant(tenant).storage.eraseAll();
  }

  /**
   * Full data wipe for a tenant (account deletion): archives, roster, push devices; revoke its
   * sessions and evict it from memory. (Tokens, entitlement and the account record are wiped by the
   * route, which owns those stores.) Wiping the roster also invalidates member tokens (memberActive).
   */
  eraseTenant(tenant: string): void {
    this.tenant(tenant).storage.eraseAll();
    this.deps.team?.eraseTenant(tenant);
    this.deps.push?.eraseTenant(tenant);
    this.sessions.revokeAll(tenant);
    const loaded = this.tenants.get(tenant);
    if (loaded) {
      loaded.controller.shutdown();
      this.tenants.delete(tenant);
    }
    logger.info('erased tenant data', { tenant });
  }
  /** Cross-session analytics — gated to plans with `advancedAnalytics`. */
  analytics(tenant: string): AnalyticsReport | null {
    if (!PLANS[this.planId(tenant)].limits.advancedAnalytics) return null;
    return aggregateSessions(this.tenant(tenant).storage.exportAll());
  }

  // --- team management (gated to plans with `teamManagement`) ---
  listTeam(tenant: string): TeamMember[] | null {
    if (!this.deps.team || !PLANS[this.planId(tenant)].limits.teamManagement) return null;
    return this.deps.team.list(tenant);
  }
  inviteMember(tenant: string, email: string, role: string): TeamMember | { error: string } | null {
    if (!this.deps.team || !PLANS[this.planId(tenant)].limits.teamManagement) return null;
    if (!isTeamRole(role) || role === 'owner') return { error: 'invalid role' };
    return this.deps.team.invite(tenant, email, role, PLANS[this.planId(tenant)].limits.seats);
  }
  removeMember(tenant: string, id: string): boolean | null {
    if (!this.deps.team || !PLANS[this.planId(tenant)].limits.teamManagement) return null;
    const removed = this.deps.team.remove(tenant, id);
    // Revoke tokens only once the member is really gone — avoids seeding the denylist
    // with arbitrary ids (which would otherwise accumulate forever).
    if (removed) this.denylist.revoke(tenant, id);
    return removed;
  }
  /** Force-logout a member (revoke their tokens) without removing them from the roster. */
  revokeMember(tenant: string, memberId: string): boolean | null {
    if (!this.deps.team || !PLANS[this.planId(tenant)].limits.teamManagement) return null;
    // Only revoke someone actually on the roster — a missing id is a 404, not a silent ok.
    if (!this.deps.team.list(tenant).some((m) => m.id === memberId)) return false;
    this.denylist.revoke(tenant, memberId);
    return true;
  }
  /** Is this member still on the tenant's roster? Revokes member tokens on removal. */
  memberActive(tenant: string, memberId: string): boolean {
    if (this.denylist.isRevoked(tenant, memberId)) return false; // instant revocation
    return this.deps.team?.list(tenant).some((m) => m.id === memberId) ?? false;
  }

  /** Is this owner session token still valid (not logged out, not revoked-all)? */
  sessionActive(tenant: string, sessionId: string, issuedAt: number): boolean {
    return this.sessions.isActive(tenant, sessionId, issuedAt);
  }

  /** Log out a single owner session. */
  revokeSession(tenant: string, sessionId: string): void {
    this.sessions.revoke(tenant, sessionId);
  }

  /** Revoke every owner session for a tenant (sign out everywhere). */
  revokeAllSessions(tenant: string): void {
    this.sessions.revokeAll(tenant);
  }

  /**
   * Apply a revocation broadcast from another instance (non-sticky fleets): parse the control
   * message and route it to the session store or member denylist. Idempotent and non-broadcasting,
   * so re-receiving our own publish (Redis echoes to the publisher) is harmless.
   */
  applyRemoteControl(raw: string): void {
    let msg: { scope?: string; tenant?: string; id?: string; ts?: number };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return; // null / number / string frame
      msg = parsed as typeof msg;
    } catch {
      return; // malformed control frame — ignore
    }
    if (msg.scope === 'member' || msg.scope === 'member-restore') this.denylist.applyRemote(msg);
    else this.sessions.applyRemote(msg);
  }

  /**
   * Read-only operator snapshot for the admin/support console. Warms the lightweight per-tenant
   * stores (plan, roster, devices) so counts are accurate even when the tenant is cold, but does
   * NOT materialize the session pipeline for a non-resident tenant — a lookup has no side effects
   * beyond a durable read. Contains no message content.
   */
  async adminSnapshot(tenant: string): Promise<AdminSnapshot> {
    const wasLoaded = this.tenants.has(tenant);
    await Promise.all([
      this.deps.entitlements?.hydrate?.(tenant),
      this.deps.team?.hydrate(tenant),
      this.deps.push?.hydrate(tenant),
    ]);
    const plan = this.planId(tenant);
    const loaded = this.tenants.get(tenant);
    const state = loaded?.controller.getState();
    const settings = loaded?.settings.get();
    return {
      tenant,
      loaded: wasLoaded,
      plan,
      connected: state?.connected ?? false,
      channels: state?.channels.map((c) => `${c.platform}:${c.channel}`) ?? [],
      viewers: state?.viewers ?? null,
      aiUsedToday: await this.readUsage(tenant),
      aiCapPerDay: PLANS[plan].limits.aiCallsPerDay,
      archives: loaded ? loaded.storage.listSessions().length : null,
      teamMembers: this.deps.team?.list(tenant).length ?? 0,
      pushDevices: this.deps.push?.list(tenant).length ?? 0,
      settings: settings
        ? {
            surfaceThreshold: settings.surfaceThreshold,
            retentionDays: settings.retentionDays,
            storeMessageText: settings.storeMessageText,
          }
        : null,
    };
  }

  private async readUsage(tenant: string): Promise<number | null> {
    const meter = this.usage;
    if (typeof meter.used !== 'function') return null;
    try {
      return await meter.used(tenant);
    } catch {
      return null;
    }
  }

  // --- push notifications (wearables / companion) — available to all plans ---
  listPush(tenant: string): PushSubscription[] {
    return this.deps.push ? this.deps.push.list(tenant) : [];
  }
  subscribePush(
    tenant: string,
    platform: string,
    endpoint: string,
    keys?: { p256dh: string; auth: string },
  ): PushSubscription | { error: string } {
    return this.deps.push
      ? this.deps.push.subscribe(tenant, platform, endpoint, keys)
      : { error: 'push unavailable' };
  }
  removePush(tenant: string, id: string): boolean {
    return this.deps.push ? this.deps.push.remove(tenant, id) : false;
  }

  /** Prune every loaded tenant's archives per its retention policy. */
  runRetention(now = Date.now()): void {
    for (const t of this.tenants.values()) {
      const days = t.settings.get().retentionDays;
      if (days <= 0) continue;
      const removed = t.storage.pruneOlderThan(now - days * 86_400_000);
      if (removed > 0) logger.info('retention pruned sessions', { tenant: t.id, removed, days });
    }
  }

  /**
   * Evict idle, disconnected tenants so the in-memory map can't grow without bound. A tenant with
   * a live session is never evicted; an evicted tenant is lazily re-created from the durable stores
   * on next access. Returns the number evicted.
   */
  sweepIdleTenants(maxIdleMs = 30 * 60_000, now = Date.now()): number {
    let evicted = 0;
    for (const t of [...this.tenants.values()]) {
      if (t.id === 'default') continue; // keep the auto-connected local/default tenant
      if (t.controller.getState().connected) continue; // never evict a live session
      if (now - t.lastTouch < maxIdleMs) continue;
      t.controller.shutdown();
      this.tenants.delete(t.id);
      evicted += 1;
    }
    if (evicted > 0) logger.info('evicted idle tenants', { evicted });
    return evicted;
  }

  /** Gracefully archive every tenant's in-flight session. */
  async shutdown(): Promise<void> {
    for (const t of this.tenants.values()) {
      t.controller.shutdown();
      await t.controller.drain(5000);
    }
  }

  private planId(tenant: string): PlanId {
    return this.deps.entitlements?.getPlan(tenant) ?? 'pro';
  }

  private async fetchViewers(
    tenant: string,
    platform: Platform,
    channel: string,
  ): Promise<number | null> {
    if (platform === 'kick') {
      return process.env['GLANCE_ENABLE_KICK'] === '1' ? kickViewers(channel) : null;
    }
    if (platform === 'twitch' && this.deps.twitchLink) {
      const token = await this.deps.twitchLink.getToken(tenant);
      return token ? twitchViewers(channel, this.deps.twitchLink.clientId, token) : null;
    }
    if (platform === 'youtube' && this.deps.youtubeLink) {
      const token = await this.deps.youtubeLink.getToken(tenant);
      return token ? youtubeViewers(token) : null;
    }
    return null;
  }

  private tenant(id: string): Tenant {
    const existing = this.tenants.get(id);
    if (existing) {
      existing.lastTouch = Date.now();
      return existing;
    }

    const storage = this.deps.makeStorage(id);
    const link = this.deps.twitchLink;
    const makeTwitchAdapter = link
      ? (channel: string): PlatformAdapter | null =>
          link.hasToken(id)
            ? new TwitchEventSubAdapter(channel, {
                clientId: link.clientId,
                getToken: () => link.getToken(id),
              })
            : null
      : undefined;
    const ytLink = this.deps.youtubeLink;
    const makeYouTubeAdapter = ytLink
      ? (channel: string): PlatformAdapter | null =>
          ytLink.hasToken(id)
            ? new YouTubeAdapter(channel, { getToken: () => ytLink.getToken(id) })
            : null
      : undefined;
    const controller = new SessionController({
      ai: this.deps.ai,
      storage,
      log: (message) => logger.info(message, { tenant: id }),
      // Meter AI calls against the tenant's plan cap.
      canUseAi: () => this.usage.tryConsume(id, PLANS[this.planId(id)].limits.aiCallsPerDay),
      makeTwitchAdapter,
      makeYouTubeAdapter,
      fetchViewers: (platform, channel) => this.fetchViewers(id, platform, channel),
      // "clip that" → a real Twitch clip via Helix (creator's token, clips:edit scope).
      clip: link
        ? async () => {
            const token = await link.getToken(id);
            return token
              ? createTwitchClip(link.clientId, token)
              : { ok: false, error: 'twitch not linked' };
          }
        : undefined,
    });
    const settingsStore = this.deps.makeSettingsStore(id);
    const settings = new SettingsService(settingsStore, (next) => {
      // Enforce the plan: clients and the engine only ever see clamped settings.
      const effective = applyPlanLimits(next, this.planId(id));
      controller.applySettings(effective);
      this.deps.bus.publish(id, { type: 'settings', data: effective });
    });
    controller.setBroadcast((message) => this.deps.bus.publish(id, message));
    controller.applySettings(applyPlanLimits(settings.get(), this.planId(id)));
    // Warm settings, plan, roster, tokens, push devices, and the revocation list from the durable
    // store (Postgres) without blocking tenant creation. Awaiting them before re-clamping closes the
    // cold-start window on a fresh instance: a paid tenant must not be served at default limits, a
    // real team roster must not be overwritten by an empty one (invite), an authenticated reader must
    // not fall back to IRC when a token exists, and a force-logout must not be forgotten. Only runs
    // when durable stores are configured. onChange applies plan limits + broadcasts.
    const entitlements = this.deps.entitlements;
    if (this.deps.kv) {
      void Promise.all([
        settingsStore.hydrate?.(),
        entitlements?.hydrate?.(id),
        this.deps.team?.hydrate(id),
        this.deps.push?.hydrate(id),
        this.deps.twitchLink?.hydrate?.(id),
        this.deps.youtubeLink?.hydrate?.(id),
        this.denylist.hydrate(id),
        this.sessions.hydrate(id),
        this.deps.analytics?.hydrate(id),
      ])
        .then(([loaded]) => {
          if (loaded) {
            settings.rehydrate(loaded);
          } else {
            const effective = applyPlanLimits(settings.get(), this.planId(id));
            controller.applySettings(effective);
            this.deps.bus.publish(id, { type: 'settings', data: effective });
          }
        })
        .catch(() => undefined);
    }

    // Apply retention the moment a tenant loads, so idle data ages out on next use.
    const retentionDays = settings.get().retentionDays;
    if (retentionDays > 0) storage.pruneOlderThan(Date.now() - retentionDays * 86_400_000);

    const tenant: Tenant = { id, controller, settings, storage, lastTouch: Date.now() };
    this.tenants.set(id, tenant);
    logger.info('tenant created', { tenant: id });
    return tenant;
  }
}

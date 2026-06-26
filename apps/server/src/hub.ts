import {
  applyPlanLimits,
  PLANS,
  type EngineSettings,
  type PlanId,
  type ScoredMessage,
  type SessionDetail,
  type SessionState,
  type SessionSummary,
} from '@glance/core';
import type { AIProvider } from '@glance/ai';
import { SessionController } from './session';
import { SettingsService, type SettingsStore } from './settings-store';
import type { Storage } from './storage';
import type { Bus } from './bus';
import { AiUsageMeter } from './ai-usage';
import { logger } from './logger';
import { metrics } from './metrics';

interface Tenant {
  id: string;
  controller: SessionController;
  settings: SettingsService;
  storage: Storage;
}

/** Resolves a tenant's billing plan. The EntitlementStore implements this; when no
 *  billing is wired the Hub defaults to `pro` (self-host / dev runs ungated). */
export interface EntitlementResolver {
  getPlan(tenant: string): PlanId;
}

export interface HubDeps {
  ai: AIProvider;
  bus: Bus;
  makeStorage: (tenant: string) => Storage;
  makeSettingsStore: (tenant: string) => SettingsStore;
  entitlements?: EntitlementResolver;
}

/**
 * Owns all tenants. Each tenant gets its own isolated pipeline (controller +
 * settings + storage); broadcasts are published to the {@link Bus} keyed by tenant.
 * Plan entitlements are enforced centrally here: settings are clamped with
 * {@link applyPlanLimits}, and AI calls are metered against the plan's daily cap.
 */
export class Hub {
  private readonly tenants = new Map<string, Tenant>();
  private readonly usage = new AiUsageMeter();

  constructor(private readonly deps: HubDeps) {
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
  connect(tenant: string, channel: string, demo: boolean): SessionState {
    return this.tenant(tenant).controller.connect(channel, demo);
  }
  disconnect(tenant: string): SessionState {
    return this.tenant(tenant).controller.disconnect();
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

  /** Prune every loaded tenant's archives per its retention policy. */
  runRetention(now = Date.now()): void {
    for (const t of this.tenants.values()) {
      const days = t.settings.get().retentionDays;
      if (days <= 0) continue;
      const removed = t.storage.pruneOlderThan(now - days * 86_400_000);
      if (removed > 0) logger.info('retention pruned sessions', { tenant: t.id, removed, days });
    }
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

  private tenant(id: string): Tenant {
    const existing = this.tenants.get(id);
    if (existing) return existing;

    const storage = this.deps.makeStorage(id);
    const controller = new SessionController({
      ai: this.deps.ai,
      storage,
      log: (message) => logger.info(message, { tenant: id }),
      // Meter AI calls against the tenant's plan cap.
      canUseAi: () => this.usage.tryConsume(id, PLANS[this.planId(id)].limits.aiCallsPerDay),
    });
    const settings = new SettingsService(this.deps.makeSettingsStore(id), (next) => {
      // Enforce the plan: clients and the engine only ever see clamped settings.
      const effective = applyPlanLimits(next, this.planId(id));
      controller.applySettings(effective);
      this.deps.bus.publish(id, { type: 'settings', data: effective });
    });
    controller.setBroadcast((message) => this.deps.bus.publish(id, message));
    controller.applySettings(applyPlanLimits(settings.get(), this.planId(id)));

    // Apply retention the moment a tenant loads, so idle data ages out on next use.
    const retentionDays = settings.get().retentionDays;
    if (retentionDays > 0) storage.pruneOlderThan(Date.now() - retentionDays * 86_400_000);

    const tenant: Tenant = { id, controller, settings, storage };
    this.tenants.set(id, tenant);
    logger.info('tenant created', { tenant: id });
    return tenant;
  }
}

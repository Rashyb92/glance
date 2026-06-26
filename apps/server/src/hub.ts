import type {
  EngineSettings,
  ScoredMessage,
  SessionDetail,
  SessionState,
  SessionSummary,
} from '@glance/core';
import type { AIProvider } from '@glance/ai';
import { SessionController } from './session';
import { SettingsService, type SettingsStore } from './settings-store';
import type { Storage } from './storage';
import type { Bus } from './bus';
import { logger } from './logger';
import { metrics } from './metrics';

interface Tenant {
  id: string;
  controller: SessionController;
  settings: SettingsService;
  storage: Storage;
}

export interface HubDeps {
  ai: AIProvider;
  bus: Bus;
  makeStorage: (tenant: string) => Storage;
  makeSettingsStore: (tenant: string) => SettingsStore;
}

/**
 * Owns all tenants. Each tenant gets its own isolated pipeline (controller +
 * settings + storage); broadcasts are published to the {@link Bus} keyed by tenant,
 * so the gateway fans them out only to that tenant's sockets. This is what makes
 * the server multi-tenant and horizontally scalable.
 */
export class Hub {
  private readonly tenants = new Map<string, Tenant>();

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
    return this.tenant(tenant).settings.get();
  }
  connect(tenant: string, channel: string, demo: boolean): SessionState {
    return this.tenant(tenant).controller.connect(channel, demo);
  }
  disconnect(tenant: string): SessionState {
    return this.tenant(tenant).controller.disconnect();
  }
  updateSettings(tenant: string, patch: unknown): EngineSettings {
    return this.tenant(tenant).settings.update(patch);
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

  private tenant(id: string): Tenant {
    const existing = this.tenants.get(id);
    if (existing) return existing;

    const storage = this.deps.makeStorage(id);
    const controller = new SessionController({
      ai: this.deps.ai,
      storage,
      log: (message) => logger.info(message, { tenant: id }),
    });
    const settings = new SettingsService(this.deps.makeSettingsStore(id), (next) => {
      controller.applySettings(next);
      this.deps.bus.publish(id, { type: 'settings', data: next });
    });
    controller.setBroadcast((message) => this.deps.bus.publish(id, message));
    controller.applySettings(settings.get());

    // Apply retention the moment a tenant loads, so idle data ages out on next use.
    const retentionDays = settings.get().retentionDays;
    if (retentionDays > 0) storage.pruneOlderThan(Date.now() - retentionDays * 86_400_000);

    const tenant: Tenant = { id, controller, settings, storage };
    this.tenants.set(id, tenant);
    logger.info('tenant created', { tenant: id });
    return tenant;
  }
}

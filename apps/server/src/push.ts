import { pushNotificationFor, type PushNotification, type ServerMessage } from '@glance/core';
import type { PushStore, PushSubscription } from './push-store';

export interface PushProvider {
  send(sub: PushSubscription, note: PushNotification): Promise<void>;
}

/**
 * Default provider: delivers `webhook` subscriptions via HTTP POST — which works
 * today (a phone/watch backend, an ntfy topic, or an iOS Shortcut can receive it).
 * APNs and FCM are pluggable behind the same interface; until a native backend is
 * wired they log, so the seam is exercised end-to-end.
 */
export class DefaultPushProvider implements PushProvider {
  constructor(
    private readonly log: (message: string) => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(sub: PushSubscription, note: PushNotification): Promise<void> {
    if (sub.platform === 'webhook') {
      try {
        await this.fetchImpl(sub.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(note),
        });
      } catch {
        /* best-effort: a flaky device must not affect the session */
      }
      return;
    }
    this.log(`push[${sub.platform}] ${note.title}: ${note.body}`);
  }
}

/**
 * Watches the broadcast stream and pushes the highest-signal moments to each tenant's
 * registered devices, with per-moment dedup and a per-tenant rate limit so a wrist
 * isn't spammed. Wired to the {@link Bus} in main, alongside the WebSocket fan-out.
 */
export class Notifier {
  private readonly lastAt = new Map<string, number>();
  private readonly lastTag = new Map<string, string>();

  constructor(
    private readonly store: PushStore,
    private readonly provider: PushProvider,
    private readonly minIntervalMs = 2000,
  ) {}

  consider(tenant: string, message: ServerMessage, now: number = Date.now()): void {
    const note = pushNotificationFor(message);
    if (!note) return;
    if (this.lastTag.get(tenant) === note.tag) return; // already pushed this moment
    const last = this.lastAt.get(tenant);
    if (last !== undefined && now - last < this.minIntervalMs) return; // rate limit
    const subs = this.store.list(tenant);
    if (subs.length === 0) return;
    this.lastTag.set(tenant, note.tag);
    this.lastAt.set(tenant, now);
    for (const sub of subs) void this.provider.send(sub, note);
  }
}

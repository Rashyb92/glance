import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@glance/core';
import type { Bus } from './bus';
import type { RedisPubSub } from './redis';

/**
 * A {@link Bus} backed by Redis pub/sub — the multi-instance fan-out. Each instance delivers
 * a published message to its **own** handlers immediately (so a down or unreachable Redis can
 * never silently swallow local delivery — the instance keeps working single-instance), and
 * also publishes it to a shared channel so the **other** instances deliver it too. Messages
 * carry an origin id; an instance ignores the echo of its own messages to avoid double-delivery.
 *
 * Swapping {@link InProcessBus} for this is the single change that makes the server horizontally
 * scalable; no caller changes (same `Bus` interface).
 */
export class RedisBus implements Bus {
  private readonly handlers: Array<(tenant: string, message: ServerMessage) => void> = [];
  private readonly origin = randomUUID();

  constructor(
    private readonly publisher: RedisPubSub,
    subscriber: RedisPubSub,
    private readonly channel = 'glance:bus',
  ) {
    void subscriber.subscribe(this.channel, (raw) => this.onRemote(raw));
  }

  publish(tenant: string, message: ServerMessage): void {
    // Local delivery first — independent of Redis, so nothing is lost if Redis is unavailable.
    this.dispatch(tenant, message);
    // Fan out to the other instances, tagged so our own echo is ignored on receipt.
    try {
      void this.publisher.publish(
        this.channel,
        JSON.stringify({ origin: this.origin, tenant, message }),
      );
    } catch {
      /* remote fan-out failed (Redis down) — local delivery already happened */
    }
  }

  subscribe(handler: (tenant: string, message: ServerMessage) => void): void {
    this.handlers.push(handler);
  }

  private onRemote(raw: string): void {
    let parsed: { origin?: string; tenant: string; message: ServerMessage };
    try {
      parsed = JSON.parse(raw) as { origin?: string; tenant: string; message: ServerMessage };
    } catch {
      return; // ignore malformed payloads
    }
    if (parsed.origin === this.origin) return; // our own message — already delivered locally
    this.dispatch(parsed.tenant, parsed.message);
  }

  private dispatch(tenant: string, message: ServerMessage): void {
    for (const handler of this.handlers) handler(tenant, message);
  }
}

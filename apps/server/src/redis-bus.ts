import type { ServerMessage } from '@glance/core';
import type { Bus } from './bus';
import type { RedisPubSub } from './redis';

/**
 * A {@link Bus} backed by Redis pub/sub — the multi-instance fan-out. Each instance
 * publishes scored items to a shared channel; every instance's subscriber receives them
 * and dispatches to local handlers (the gateway's WS rooms and the Notifier). Swapping
 * {@link InProcessBus} for this is the single change that makes the server horizontally
 * scalable; no caller changes (same `Bus` interface).
 */
export class RedisBus implements Bus {
  private readonly handlers: Array<(tenant: string, message: ServerMessage) => void> = [];

  constructor(
    private readonly publisher: RedisPubSub,
    subscriber: RedisPubSub,
    private readonly channel = 'glance:bus',
  ) {
    void subscriber.subscribe(this.channel, (raw) => this.dispatch(raw));
  }

  publish(tenant: string, message: ServerMessage): void {
    void this.publisher.publish(this.channel, JSON.stringify({ tenant, message }));
  }

  subscribe(handler: (tenant: string, message: ServerMessage) => void): void {
    this.handlers.push(handler);
  }

  private dispatch(raw: string): void {
    let parsed: { tenant: string; message: ServerMessage };
    try {
      parsed = JSON.parse(raw) as { tenant: string; message: ServerMessage };
    } catch {
      return; // ignore malformed payloads
    }
    for (const handler of this.handlers) handler(parsed.tenant, parsed.message);
  }
}

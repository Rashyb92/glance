import type { ServerMessage } from '@glance/core';

/**
 * Pub/sub fan-out seam, keyed by tenant. The in-process implementation delivers
 * synchronously to local subscribers; a Redis/NATS implementation behind the same
 * interface lets many stateless gateway instances share tenant state (the path to
 * horizontal scale). The gateway subscribes; tenant controllers publish.
 */
export interface Bus {
  publish(tenant: string, message: ServerMessage): void;
  subscribe(handler: (tenant: string, message: ServerMessage) => void): void;
}

export class InProcessBus implements Bus {
  private readonly handlers: Array<(tenant: string, message: ServerMessage) => void> = [];

  publish(tenant: string, message: ServerMessage): void {
    for (const handler of this.handlers) handler(tenant, message);
  }

  subscribe(handler: (tenant: string, message: ServerMessage) => void): void {
    this.handlers.push(handler);
  }
}

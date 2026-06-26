import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@glance/core';
import { InProcessBus } from '../src/bus';

const hello = (ts: number): ServerMessage => ({ type: 'hello', data: { ts } });

describe('InProcessBus', () => {
  it('delivers a published message to every subscriber, tagged with its tenant', () => {
    const bus = new InProcessBus();
    const got: Array<{ tenant: string; type: string }> = [];
    bus.subscribe((tenant, msg) => got.push({ tenant, type: msg.type }));
    bus.subscribe((tenant, msg) => got.push({ tenant, type: msg.type }));

    bus.publish('acme', hello(1));

    expect(got).toEqual([
      { tenant: 'acme', type: 'hello' },
      { tenant: 'acme', type: 'hello' },
    ]);
  });

  it('preserves the tenant key so the gateway can route to the right room', () => {
    const bus = new InProcessBus();
    const seen: string[] = [];
    bus.subscribe((tenant) => seen.push(tenant));

    bus.publish('a', hello(1));
    bus.publish('b', hello(2));

    expect(seen).toEqual(['a', 'b']);
  });

  it('is a no-op when there are no subscribers', () => {
    const bus = new InProcessBus();
    expect(() => bus.publish('a', hello(1))).not.toThrow();
  });
});

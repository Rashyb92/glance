import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AIProvider } from '@glance/ai';
import type { ServerMessage } from '@glance/core';
import { Hub } from '../src/hub';
import { InProcessBus } from '../src/bus';
import { FileStorage } from '../src/storage';
import { FileSettingsStore } from '../src/settings-store';

// The AI provider is never invoked by these tests (no live session), so a name-only
// stub is sufficient.
const ai = { name: 'stub' } as unknown as AIProvider;

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function makeHub() {
  root = mkdtempSync(join(tmpdir(), 'glance-hub-'));
  const bus = new InProcessBus();
  const published: Array<{ tenant: string; type: string }> = [];
  bus.subscribe((tenant, msg: ServerMessage) => published.push({ tenant, type: msg.type }));
  const hub = new Hub({
    ai,
    bus,
    makeStorage: (t) => new FileStorage(join(root, 'sessions', t)),
    makeSettingsStore: (t) => new FileSettingsStore(join(root, 'settings', `${t}.json`)),
  });
  return { hub, published };
}

describe('Hub — tenant isolation (no data leaks)', () => {
  it('keeps settings separate per tenant', () => {
    const { hub } = makeHub();
    hub.updateSettings('alice', { surfaceThreshold: 0.9 });
    expect(hub.getSettings('alice').surfaceThreshold).toBe(0.9);
    expect(hub.getSettings('bob').surfaceThreshold).toBe(0.5); // default — unaffected by alice
  });

  it('evicts idle, disconnected tenants (keeping default) and re-creates lazily', () => {
    const { hub } = makeHub();
    hub.getSettings('ten1'); // create a disconnected tenant
    hub.getSettings('default'); // default is never evicted
    expect(hub.sweepIdleTenants(0)).toBe(1); // ten1 evicted (not connected, idle)
    expect(hub.getSettings('ten1').surfaceThreshold).toBe(0.5); // re-created from the durable store
  });

  it('scopes broadcasts to the originating tenant', () => {
    const { hub, published } = makeHub();
    hub.updateSettings('alice', { surfaceThreshold: 0.8 });
    expect(published.some((p) => p.tenant === 'alice' && p.type === 'settings')).toBe(true);
    expect(published.some((p) => p.tenant === 'bob')).toBe(false);
  });

  it('keeps archives physically separate per tenant', () => {
    const { hub } = makeHub();
    hub.getSettings('bob'); // materialize bob
    expect(hub.listSessions('alice')).toEqual([]);
    expect(hub.exportAll('bob')).toEqual([]);
  });
});

describe('Hub — remote revocation control channel', () => {
  it('routes a member frame to the denylist (instant revoke from another instance)', () => {
    const { hub } = makeHub();
    expect(hub.memberActive('t1', 'm1')).toBe(false); // not on roster anyway
    hub.applyRemoteControl(JSON.stringify({ scope: 'member', tenant: 't1', id: 'm1' }));
    expect(hub.memberActive('t1', 'm1')).toBe(false); // denylisted
    hub.applyRemoteControl(JSON.stringify({ scope: 'member-restore', tenant: 't1', id: 'm1' }));
    expect(hub.memberActive('t1', 'm1')).toBe(false); // restore clears the denylist (roster still empty)
  });

  it('routes session frames to the session store', () => {
    const { hub } = makeHub();
    hub.applyRemoteControl(JSON.stringify({ scope: 'session', tenant: 't1', id: 's1' }));
    expect(hub.sessionActive('t1', 's1', 1000)).toBe(false); // logged out remotely
    hub.applyRemoteControl(JSON.stringify({ scope: 'session-all', tenant: 't1', ts: 5000 }));
    expect(hub.sessionActive('t1', 's2', 4999)).toBe(false); // issued before the remote epoch
    expect(hub.sessionActive('t1', 's2', 6000)).toBe(true);
  });

  it('ignores malformed and non-object control frames without throwing', () => {
    const { hub } = makeHub();
    expect(() => hub.applyRemoteControl('{not json')).not.toThrow();
    expect(() => hub.applyRemoteControl('null')).not.toThrow();
    expect(() => hub.applyRemoteControl('42')).not.toThrow();
    expect(hub.sessionActive('t1', 's1', 1000)).toBe(true); // nothing was applied
  });
});

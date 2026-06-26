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

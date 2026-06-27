import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushStore } from '../src/push-store';

let dir: string;
let store: PushStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glance-push-'));
  store = new PushStore(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PushStore', () => {
  it('registers a webhook device and lists it', () => {
    expect('error' in store.subscribe('acme', 'webhook', 'https://hooks.test/abc')).toBe(false);
    expect(store.list('acme').length).toBe(1);
  });

  it('rejects a non-https webhook and an invalid platform', () => {
    expect(store.subscribe('acme', 'webhook', 'http://x')).toEqual({ error: 'endpoint must be https' });
    expect(store.subscribe('acme', 'carrier-pigeon', 'x')).toEqual({ error: 'invalid platform' });
  });

  it('is idempotent on re-register and isolates tenants', () => {
    const a = store.subscribe('acme', 'webhook', 'https://h.test/x') as { id: string };
    const b = store.subscribe('acme', 'webhook', 'https://h.test/x') as { id: string };
    expect(b.id).toBe(a.id);
    expect(store.list('other')).toEqual([]);
  });

  it('accepts apns/fcm device tokens and removes by id', () => {
    const s = store.subscribe('acme', 'apns', 'devicetoken123') as { id: string };
    expect(store.remove('acme', s.id)).toBe(true);
    expect(store.list('acme')).toEqual([]);
    expect(store.remove('acme', 'gone')).toBe(false);
  });
});

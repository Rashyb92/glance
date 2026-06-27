import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushStore, isSafePushEndpoint } from '../src/push-store';

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
    expect(store.subscribe('acme', 'webhook', 'http://x')).toEqual({
      error: 'endpoint must be a public https url',
    });
    expect(store.subscribe('acme', 'carrier-pigeon', 'x')).toEqual({ error: 'invalid platform' });
  });

  it('rejects an SSRF push endpoint (private / metadata host)', () => {
    expect(store.subscribe('acme', 'webhook', 'https://169.254.169.254/latest')).toEqual({
      error: 'endpoint must be a public https url',
    });
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

describe('isSafePushEndpoint (SSRF guard)', () => {
  it('allows public https push services', () => {
    expect(isSafePushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isSafePushEndpoint('https://web.push.apple.com/abc')).toBe(true);
  });

  it('blocks non-https, loopback, private, CGNAT, link-local and metadata targets', () => {
    for (const bad of [
      'http://fcm.googleapis.com',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://192.168.1.10/x',
      'https://172.16.0.1/x',
      'https://100.64.0.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x',
      'https://[fd00::1]/x',
      'not a url',
    ]) {
      expect(isSafePushEndpoint(bad)).toBe(false);
    }
  });
});

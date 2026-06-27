import { describe, it, expect } from 'vitest';
import { DEFAULT_ENGINE_SETTINGS } from '@glance/core';
import { KvSettingsStore, SettingsService } from '../src/settings-store';
import { MemoryKvStore } from '../src/kv';

describe('KvSettingsStore', () => {
  it('writes through to the KV store and hydrates back', async () => {
    const kv = new MemoryKvStore();
    const store = new KvSettingsStore(kv, 'settings:acme');
    expect(store.load().pace).toBe('live'); // defaults before any save/hydrate

    store.save({ ...DEFAULT_ENGINE_SETTINGS, surfaceThreshold: 0.9, pace: 'calm' });
    expect(await kv.get('settings:acme')).toContain('"surfaceThreshold":0.9');

    // A fresh store over the same KV hydrates the persisted value into its cache.
    const fresh = new KvSettingsStore(kv, 'settings:acme');
    const loaded = await fresh.hydrate();
    expect(loaded?.surfaceThreshold).toBe(0.9);
    expect(loaded?.pace).toBe('calm');
    expect(fresh.load().surfaceThreshold).toBe(0.9);
  });

  it('hydrate returns null when nothing is stored, staying on defaults', async () => {
    const store = new KvSettingsStore(new MemoryKvStore(), 'settings:empty');
    expect(await store.hydrate()).toBeNull();
    expect(store.load()).toEqual(DEFAULT_ENGINE_SETTINGS);
  });

  it('normalizes/clamps persisted junk on hydrate', async () => {
    const kv = new MemoryKvStore();
    await kv.put('settings:x', JSON.stringify({ surfaceThreshold: 5, pace: 'turbo' }));
    const loaded = await new KvSettingsStore(kv, 'settings:x').hydrate();
    expect(loaded?.surfaceThreshold).toBe(1); // clamped to 0..1
    expect(loaded?.pace).toBe('live'); // invalid enum → default
  });
});

describe('SettingsService.rehydrate', () => {
  it('replaces live settings and notifies the listener', () => {
    let notified: number | null = null;
    const svc = new SettingsService(new KvSettingsStore(new MemoryKvStore(), 'k'), (s) => {
      notified = s.surfaceThreshold;
    });
    expect(svc.get().surfaceThreshold).toBe(0.5);
    svc.rehydrate({ ...DEFAULT_ENGINE_SETTINGS, surfaceThreshold: 0.77 });
    expect(svc.get().surfaceThreshold).toBe(0.77);
    expect(notified).toBe(0.77);
  });
});

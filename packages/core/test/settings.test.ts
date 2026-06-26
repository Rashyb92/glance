import { describe, it, expect } from 'vitest';
import { normalizeEngineSettings, DEFAULT_ENGINE_SETTINGS } from '../src/settings';

describe('normalizeEngineSettings', () => {
  it('returns defaults for empty or junk input', () => {
    expect(normalizeEngineSettings({})).toEqual(DEFAULT_ENGINE_SETTINGS);
    expect(normalizeEngineSettings(null)).toEqual(DEFAULT_ENGINE_SETTINGS);
    expect(normalizeEngineSettings(42)).toEqual(DEFAULT_ENGINE_SETTINGS);
  });

  it('clamps the threshold to 0..1', () => {
    expect(normalizeEngineSettings({ surfaceThreshold: 2 }).surfaceThreshold).toBe(1);
    expect(normalizeEngineSettings({ surfaceThreshold: -3 }).surfaceThreshold).toBe(0);
    expect(normalizeEngineSettings({ surfaceThreshold: 0.62 }).surfaceThreshold).toBe(0.62);
  });

  it('bounds the AI interval', () => {
    expect(normalizeEngineSettings({ summaryIntervalMs: 10 }).summaryIntervalMs).toBe(4000);
    expect(normalizeEngineSettings({ summaryIntervalMs: 999_999 }).summaryIntervalMs).toBe(120_000);
  });

  it('trims, lowercases, dedupes and caps keywords', () => {
    expect(normalizeEngineSettings({ keywords: [' Food ', 'food', 'CHALLENGE'] }).keywords).toEqual([
      'food',
      'challenge',
    ]);
  });

  it('accepts comma-separated keyword strings', () => {
    expect(normalizeEngineSettings({ keywords: 'a, b ,a' }).keywords).toEqual(['a', 'b']);
  });
});

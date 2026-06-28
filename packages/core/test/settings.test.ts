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

  it('defaults the routing matrix and filters invalid channels', () => {
    const s = normalizeEngineSettings({
      routing: { donation: ['voice', 'bogus'], chatter: ['display'] },
    });
    expect(s.routing.donation).toEqual(['voice']); // 'bogus' dropped
    expect(s.routing.chatter).toEqual(['display']); // overridden
    expect(s.routing.question).toEqual(['display', 'voice']); // untouched → default
  });

  it('includes routing in the defaults', () => {
    expect(normalizeEngineSettings({}).routing).toEqual(DEFAULT_ENGINE_SETTINGS.routing);
  });

  it('defaults and validates the AI + moderation toggles', () => {
    const d = normalizeEngineSettings({});
    expect(d.aiSummaries).toBe(true);
    expect(d.aiPriorities).toBe(true);
    expect(d.moderation).toBe(true);
    expect(d.moderationSensitivity).toBe(0.5);
    expect(normalizeEngineSettings({ aiSummaries: false }).aiSummaries).toBe(false);
    expect(normalizeEngineSettings({ moderationSensitivity: 5 }).moderationSensitivity).toBe(1);
    expect(normalizeEngineSettings({ moderation: 'yes' }).moderation).toBe(true); // non-bool → default
  });

  it('defaults and bounds the data-protection controls', () => {
    const d = normalizeEngineSettings({});
    expect(d.retentionDays).toBe(7); // privacy-first default
    expect(d.storeMessageText).toBe(false); // privacy-first default (metadata only)
    expect(normalizeEngineSettings({ retentionDays: -5 }).retentionDays).toBe(0);
    expect(normalizeEngineSettings({ retentionDays: 99_999 }).retentionDays).toBe(3650);
    expect(normalizeEngineSettings({ storeMessageText: true }).storeMessageText).toBe(true);
  });

  it('defaults and validates the chat pace', () => {
    expect(normalizeEngineSettings({}).pace).toBe('live');
    expect(normalizeEngineSettings({ pace: 'calm' }).pace).toBe('calm');
    expect(normalizeEngineSettings({ pace: 'balanced' }).pace).toBe('balanced');
    expect(normalizeEngineSettings({ pace: 'turbo' }).pace).toBe('live'); // invalid → default
  });

  it('sanitizes branding (color, https-only logo, name length)', () => {
    expect(normalizeEngineSettings({}).branding).toEqual(DEFAULT_ENGINE_SETTINGS.branding);
    const s = normalizeEngineSettings({
      branding: {
        name: '  Acme Stream  ',
        accentColor: '#abcdef',
        logoUrl: 'https://cdn.example/logo.png',
      },
    });
    expect(s.branding).toEqual({
      name: 'Acme Stream',
      accentColor: '#abcdef',
      logoUrl: 'https://cdn.example/logo.png',
    });
    // rejects a bad color and a non-https logo (XSS guard)
    const bad = normalizeEngineSettings({
      branding: { accentColor: 'red', logoUrl: 'javascript:alert(1)' },
    });
    expect(bad.branding.accentColor).toBe('#7c5cff');
    expect(bad.branding.logoUrl).toBe('');
  });
});

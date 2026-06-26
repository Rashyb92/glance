import { describe, it, expect } from 'vitest';
import { applyPlanLimits, PLANS, planFor } from '../src/plans';
import { DEFAULT_ENGINE_SETTINGS } from '../src/settings';

describe('plans / entitlements', () => {
  it('caps retention to the plan limit', () => {
    const s = { ...DEFAULT_ENGINE_SETTINGS, retentionDays: 9999 };
    expect(applyPlanLimits(s, 'free').retentionDays).toBe(PLANS.free.limits.retentionDaysCap);
    expect(applyPlanLimits(s, 'pro').retentionDays).toBe(PLANS.pro.limits.retentionDaysCap);
  });

  it('treats "keep forever" (0) as the plan cap', () => {
    const s = { ...DEFAULT_ENGINE_SETTINGS, retentionDays: 0 };
    expect(applyPlanLimits(s, 'creator').retentionDays).toBe(PLANS.creator.limits.retentionDaysCap);
  });

  it('disables AI priorities below the entitled tier', () => {
    const s = { ...DEFAULT_ENGINE_SETTINGS, aiPriorities: true };
    expect(applyPlanLimits(s, 'free').aiPriorities).toBe(false);
    expect(applyPlanLimits(s, 'creator').aiPriorities).toBe(true);
  });

  it('strips audio routing on plans without audio, keeps it on those with', () => {
    const s = { ...DEFAULT_ENGINE_SETTINGS };
    const free = applyPlanLimits(s, 'free');
    for (const channels of Object.values(free.routing)) {
      expect(channels?.every((c) => c === 'display')).toBe(true);
    }
    expect(applyPlanLimits(s, 'pro').routing).toEqual(s.routing);
  });

  it('falls back to the default plan for unknown ids', () => {
    expect(planFor('bogus').id).toBe('free');
    expect(planFor('pro').id).toBe('pro');
  });

  it('gates top-tier (Elite) features to Pro only', () => {
    expect(PLANS.free.limits.moderationActions).toBe(false);
    expect(PLANS.creator.limits.moderationActions).toBe(false);
    expect(PLANS.pro.limits.moderationActions).toBe(true);
    expect(PLANS.pro.limits.advancedAnalytics).toBe(true);
    expect(PLANS.pro.limits.brandedOverlays).toBe(true);
    expect(PLANS.pro.limits.teamManagement).toBe(true);
  });

  it('scales the AI usage cap up by tier', () => {
    expect(PLANS.free.limits.aiCallsPerDay).toBeGreaterThan(0);
    expect(PLANS.free.limits.aiCallsPerDay).toBeLessThan(PLANS.creator.limits.aiCallsPerDay);
    expect(PLANS.creator.limits.aiCallsPerDay).toBeLessThan(PLANS.pro.limits.aiCallsPerDay);
  });

  it('gates pace control to paid tiers (Free is real-time only)', () => {
    expect(PLANS.free.limits.paceControl).toBe(false);
    expect(PLANS.creator.limits.paceControl).toBe(true);
    expect(PLANS.pro.limits.paceControl).toBe(true);
    const calm = { ...DEFAULT_ENGINE_SETTINGS, pace: 'calm' as const };
    expect(applyPlanLimits(calm, 'free').pace).toBe('live'); // clamped to real-time
    expect(applyPlanLimits(calm, 'creator').pace).toBe('calm'); // allowed
    expect(applyPlanLimits(calm, 'pro').pace).toBe('calm');
  });

  it('reserves priority support for the top tier', () => {
    expect(PLANS.free.limits.prioritySupport).toBe(false);
    expect(PLANS.creator.limits.prioritySupport).toBe(false);
    expect(PLANS.pro.limits.prioritySupport).toBe(true);
  });

  it('resets branding on plans without branded overlays', () => {
    const s = {
      ...DEFAULT_ENGINE_SETTINGS,
      branding: { name: 'Acme', accentColor: '#abcdef', logoUrl: 'https://x.test/a.png' },
    };
    expect(applyPlanLimits(s, 'free').branding).toEqual({
      name: '',
      accentColor: '#7c5cff',
      logoUrl: '',
    });
    expect(applyPlanLimits(s, 'pro').branding).toEqual(s.branding);
  });
});

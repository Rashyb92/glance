import { DEFAULT_BRANDING, type EngineSettings, type RoutingMatrix } from './settings';
import type { SalienceCategory } from './types';

/**
 * @glance/core — subscription plans + entitlements.
 *
 * The plan model is the single source of truth for what each tier may do. The
 * server resolves a tenant's plan and calls {@link applyPlanLimits} so a tenant can
 * never exceed its entitlement — even if it POSTs settings beyond its tier. The
 * primary monetization lever is `aiCallsPerDay`: a daily cap on Claude usage
 * (summaries, priority re-ranking, recaps), metered per tenant. Pure + unit-tested.
 *
 * Tiers map to the product blueprint as: Free → Free, Creator → "Pro" (serious solo
 * streamers), Pro → "Elite" (large creators, agencies, teams).
 */
export type PlanId = 'free' | 'creator' | 'pro';

export interface PlanLimits {
  maxConcurrentSessions: number;
  /** Largest retention the tenant may configure, in days. */
  retentionDaysCap: number;
  /** Daily cap on AI (Claude) calls — summaries + priority re-rank + recaps. */
  aiCallsPerDay: number;
  /** Claude priority re-ranking ("priority callouts"). */
  aiPriorities: boolean;
  /** Voice / earcon output routing (vs display-only). */
  audioRouting: boolean;
  /** Link more than one streaming platform at once. */
  multiPlatform: boolean;
  /** Choose a calmer chat pace (Balanced / Calm); Free is real-time only. */
  paceControl: boolean;
  // --- top-tier ("Elite") features ---
  /** Automated moderation actions (timeout/delete), not just flagging. */
  moderationActions: boolean;
  /** Historical, cross-session, exportable analytics. */
  advancedAnalytics: boolean;
  /** Custom-branded / white-label overlays. */
  brandedOverlays: boolean;
  /** Team seats, roles and shared access. */
  teamManagement: boolean;
  seats: number;
  /** Priority human support — faster response SLAs (top tier). */
  prioritySupport: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthlyGbp: number;
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthlyGbp: 0,
    limits: {
      maxConcurrentSessions: 1,
      retentionDaysCap: 7,
      aiCallsPerDay: 500,
      aiPriorities: false,
      audioRouting: false,
      multiPlatform: false,
      paceControl: false,
      moderationActions: false,
      advancedAnalytics: false,
      brandedOverlays: false,
      teamManagement: false,
      seats: 1,
      prioritySupport: false,
    },
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    priceMonthlyGbp: 15,
    limits: {
      maxConcurrentSessions: 1,
      retentionDaysCap: 90,
      aiCallsPerDay: 10_000,
      aiPriorities: true,
      audioRouting: true,
      multiPlatform: true,
      paceControl: true,
      moderationActions: false,
      advancedAnalytics: false,
      brandedOverlays: false,
      teamManagement: false,
      seats: 1,
      prioritySupport: false,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthlyGbp: 39,
    limits: {
      maxConcurrentSessions: 3,
      retentionDaysCap: 365,
      aiCallsPerDay: 200_000,
      aiPriorities: true,
      audioRouting: true,
      multiPlatform: true,
      paceControl: true,
      moderationActions: true,
      advancedAnalytics: true,
      brandedOverlays: true,
      teamManagement: true,
      seats: 5,
      prioritySupport: true,
    },
  },
};

/** Display currency for plan prices. The charging currency is configured in Stripe. */
export const PRICE_CURRENCY = 'GBP';

export const DEFAULT_PLAN: PlanId = 'free';

export function isPlanId(value: string): value is PlanId {
  return value === 'free' || value === 'creator' || value === 'pro';
}

export function planFor(id: string | undefined): Plan {
  return id && isPlanId(id) ? PLANS[id] : PLANS[DEFAULT_PLAN];
}

/**
 * Clamp engine settings to a plan's entitlements. Never throws — it downgrades:
 * retention is capped, and gated features (AI priorities, AI summaries when the
 * plan has no AI budget, audio routing) switch off rather than reject, so a
 * downgraded tenant keeps working.
 */
export function applyPlanLimits(settings: EngineSettings, planId: PlanId): EngineSettings {
  const limits = PLANS[planId].limits;
  const requested = settings.retentionDays;
  // 0 means "keep forever" — not allowed beyond the cap, so treat it as the cap.
  const retentionDays =
    requested === 0 ? limits.retentionDaysCap : Math.min(requested, limits.retentionDaysCap);
  const hasAiBudget = limits.aiCallsPerDay > 0;
  return {
    ...settings,
    retentionDays,
    pace: limits.paceControl ? settings.pace : 'live',
    aiSummaries: settings.aiSummaries && hasAiBudget,
    aiPriorities: settings.aiPriorities && limits.aiPriorities && hasAiBudget,
    routing: limits.audioRouting ? settings.routing : stripAudio(settings.routing),
    branding: limits.brandedOverlays ? settings.branding : { ...DEFAULT_BRANDING },
  };
}

function stripAudio(routing: RoutingMatrix): RoutingMatrix {
  const out: RoutingMatrix = {};
  for (const [category, channels] of Object.entries(routing)) {
    out[category as SalienceCategory] = (channels ?? []).filter((c) => c === 'display');
  }
  return out;
}

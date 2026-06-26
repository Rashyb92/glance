import type { EngineSettings, RoutingMatrix } from './settings';
import type { SalienceCategory } from './types';

/**
 * @glance/core — subscription plans + entitlements.
 *
 * The plan model is the single source of truth for what each tier may do. The
 * server resolves a tenant's plan (from the billing/entitlement store) and calls
 * {@link applyPlanLimits} so a tenant can never exceed its entitlement — even if it
 * POSTs settings beyond its tier. Pure and unit-tested.
 */
export type PlanId = 'free' | 'creator' | 'pro';

export interface PlanLimits {
  maxConcurrentSessions: number;
  /** Largest retention the tenant may configure, in days. */
  retentionDaysCap: number;
  /** Claude re-ranking ("priority callouts"). */
  aiPriorities: boolean;
  /** Voice / earcon output routing (vs display-only). */
  audioRouting: boolean;
  /** Link more than one streaming platform at once. */
  multiPlatform: boolean;
  seats: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  priceMonthlyUsd: number;
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthlyUsd: 0,
    limits: {
      maxConcurrentSessions: 1,
      retentionDaysCap: 7,
      aiPriorities: false,
      audioRouting: false,
      multiPlatform: false,
      seats: 1,
    },
  },
  creator: {
    id: 'creator',
    name: 'Creator',
    priceMonthlyUsd: 12,
    limits: {
      maxConcurrentSessions: 1,
      retentionDaysCap: 90,
      aiPriorities: true,
      audioRouting: true,
      multiPlatform: false,
      seats: 1,
    },
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthlyUsd: 39,
    limits: {
      maxConcurrentSessions: 3,
      retentionDaysCap: 365,
      aiPriorities: true,
      audioRouting: true,
      multiPlatform: true,
      seats: 5,
    },
  },
};

export const DEFAULT_PLAN: PlanId = 'free';

export function isPlanId(value: string): value is PlanId {
  return value === 'free' || value === 'creator' || value === 'pro';
}

export function planFor(id: string | undefined): Plan {
  return id && isPlanId(id) ? PLANS[id] : PLANS[DEFAULT_PLAN];
}

/**
 * Clamp engine settings to a plan's entitlements. Never throws — it downgrades:
 * retention is capped, and gated features (AI priorities, audio routing) are
 * disabled rather than rejected, so a downgraded tenant keeps working.
 */
export function applyPlanLimits(settings: EngineSettings, planId: PlanId): EngineSettings {
  const limits = PLANS[planId].limits;
  const requested = settings.retentionDays;
  // 0 means "keep forever" — not allowed beyond the cap, so treat it as the cap.
  const retentionDays =
    requested === 0 ? limits.retentionDaysCap : Math.min(requested, limits.retentionDaysCap);
  return {
    ...settings,
    retentionDays,
    aiPriorities: settings.aiPriorities && limits.aiPriorities,
    routing: limits.audioRouting ? settings.routing : stripAudio(settings.routing),
  };
}

function stripAudio(routing: RoutingMatrix): RoutingMatrix {
  const out: RoutingMatrix = {};
  for (const [category, channels] of Object.entries(routing)) {
    out[category as SalienceCategory] = (channels ?? []).filter((c) => c === 'display');
  }
  return out;
}

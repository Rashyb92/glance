import type {
  AnalyticsReport,
  EngineSettings,
  SessionDetail,
  SessionSummary,
  TeamMember,
} from '@glance/core';
import { API_BASE as BASE, getToken } from './auth';

// Control-plane + replay calls to the Glance server. Live state (session/settings)
// is echoed back over the WebSocket, so the mutating helpers ignore the body.
// BASE + the runtime session token come from ./auth (set VITE_GLANCE_API_URL in production).
function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const token = getToken();
  if (token) h['authorization'] = `Bearer ${token}`;
  return h;
}

export async function connectSession(
  channel: string,
  demo: boolean,
  platform: 'twitch' | 'youtube' | 'kick' = 'twitch',
): Promise<void> {
  await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ channel, demo, platform }),
  });
}

/** Connect several sources at once into one merged feed (unified multi-channel). */
export async function connectSessionMany(
  channels: Array<{ platform: 'twitch' | 'youtube' | 'kick'; channel: string }>,
  demo: boolean,
): Promise<void> {
  await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ channels, demo }),
  });
}

export async function disconnectSession(): Promise<void> {
  await fetch(`${BASE}/api/session`, { method: 'DELETE', headers: headers() });
}

export async function updateSettings(patch: Partial<EngineSettings>): Promise<void> {
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(patch),
  });
}

export async function listSessions(): Promise<SessionSummary[]> {
  const r = await fetch(`${BASE}/api/sessions`, { headers: headers() });
  return r.ok ? ((await r.json()) as SessionSummary[]) : [];
}

export async function getReplay(id: string): Promise<SessionDetail | null> {
  const r = await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`, { headers: headers() });
  return r.ok ? ((await r.json()) as SessionDetail) : null;
}

export async function deleteReplay(id: string): Promise<void> {
  await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: headers(),
  });
}

/** Cross-session analytics. Returns null when the plan doesn't include it (403). */
export async function getAnalytics(): Promise<AnalyticsReport | null> {
  const r = await fetch(`${BASE}/api/analytics`, { headers: headers() });
  return r.ok ? ((await r.json()) as AnalyticsReport) : null;
}

/** URL the browser navigates to in order to link a streaming account (GET redirect flow). */
export function oauthStartUrl(provider: 'twitch' | 'youtube' | 'kick'): string {
  const token = getToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${BASE}/api/oauth/${provider}/start${q}`;
}

/** Start a subscription checkout; returns the hosted Stripe URL to redirect to (or null). */
export async function startCheckout(plan: 'creator' | 'pro'): Promise<string | null> {
  const r = await fetch(`${BASE}/api/billing/checkout`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ plan }),
  });
  if (!r.ok) return null;
  return ((await r.json()) as { url?: string }).url ?? null;
}

/** Open the Stripe customer portal; returns the URL to redirect to (or null). */
export async function openBillingPortal(): Promise<string | null> {
  const r = await fetch(`${BASE}/api/billing/portal`, { method: 'POST', headers: headers() });
  if (!r.ok) return null;
  return ((await r.json()) as { url?: string }).url ?? null;
}

/** Team roster. Returns null when the plan doesn't include team management (403). */
export async function listTeam(): Promise<TeamMember[] | null> {
  const r = await fetch(`${BASE}/api/team`, { headers: headers() });
  return r.ok ? ((await r.json()) as TeamMember[]) : null;
}

/** Invite a teammate by email + role. Returns the new member or an error message. */
export async function inviteMember(
  email: string,
  role: 'admin' | 'member',
): Promise<TeamMember | { error: string }> {
  const r = await fetch(`${BASE}/api/team`, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ email, role }),
  });
  return (await r.json()) as TeamMember | { error: string };
}

export async function removeMember(id: string): Promise<void> {
  await fetch(`${BASE}/api/team/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() });
}

/** Mint a per-member login token (admins/owners only). Returns the token, or null. */
export async function memberLoginToken(id: string): Promise<string | null> {
  const r = await fetch(`${BASE}/api/team/${encodeURIComponent(id)}/login`, {
    method: 'POST',
    headers: headers(),
  });
  if (!r.ok) return null;
  return ((await r.json()) as { token?: string }).token ?? null;
}

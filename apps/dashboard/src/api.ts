import type { AnalyticsReport, EngineSettings, SessionDetail, SessionSummary } from '@glance/core';

// Control-plane + replay calls to the Glance server. Live state (session/settings)
// is echoed back over the WebSocket, so the mutating helpers ignore the body.
// Deploy-configurable: set VITE_GLANCE_API_URL to a full https:// URL in production.
const BASE =
  (import.meta.env['VITE_GLANCE_API_URL'] as string | undefined) ??
  `http://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`;

// VITE_GLANCE_TOKEN selects the tenant (absent → the server's `default` tenant).
const TOKEN = import.meta.env['VITE_GLANCE_TOKEN'] as string | undefined;
function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (TOKEN) h['authorization'] = `Bearer ${TOKEN}`;
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
  const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';
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

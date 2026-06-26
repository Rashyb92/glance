import type { EngineSettings, SessionDetail, SessionSummary } from '@glance/core';

// Control-plane + replay calls to the Glance server. Live state (session/settings)
// is echoed back over the WebSocket, so the mutating helpers ignore the body.
const WS_PORT = (import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787';
const BASE = `http://localhost:${WS_PORT}`;

export async function connectSession(channel: string, demo: boolean): Promise<void> {
  await fetch(`${BASE}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, demo }),
  });
}

export async function disconnectSession(): Promise<void> {
  await fetch(`${BASE}/api/session`, { method: 'DELETE' });
}

export async function updateSettings(patch: Partial<EngineSettings>): Promise<void> {
  await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function listSessions(): Promise<SessionSummary[]> {
  const r = await fetch(`${BASE}/api/sessions`);
  return r.ok ? ((await r.json()) as SessionSummary[]) : [];
}

export async function getReplay(id: string): Promise<SessionDetail | null> {
  const r = await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`);
  return r.ok ? ((await r.json()) as SessionDetail) : null;
}

export async function deleteReplay(id: string): Promise<void> {
  await fetch(`${BASE}/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

import type { EngineSettings } from '@glance/core';

// Control-plane calls to the Glance server. The resulting state is echoed back to
// every client over the WebSocket (session / settings messages), so these helpers
// don't need to read the response body.
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

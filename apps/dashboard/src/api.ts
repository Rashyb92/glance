// Control-plane calls to the Glance server. The resulting session state comes
// back to every client over the WebSocket as a `session` message, so these
// helpers don't need to read the response body.
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

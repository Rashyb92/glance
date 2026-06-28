// Device pairing for the phone companion. The creator opens this surface via a paired link from
// the dashboard (`?pair=<code>`); the one-time code is exchanged for this device's own session
// token, persisted to sessionStorage, and stripped from the URL. (Legacy `?token=` links are still
// honored.) A build-time VITE_GLANCE_TOKEN remains a dev / self-host fallback — never the prod path.
const KEY = 'glance_token';

const API_BASE =
  (import.meta.env['VITE_GLANCE_API_URL'] as string | undefined) ??
  `http://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`;

/** The device's token: from a prior pairing (sessionStorage), else the dev fallback. */
export function getToken(): string | undefined {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  return (import.meta.env['VITE_GLANCE_TOKEN'] as string | undefined) || undefined;
}

/** Exchange a one-time pairing code for this device's own session token, then persist it. */
async function exchangePairCode(code: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/pair/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      if (data.token) sessionStorage.setItem(KEY, data.token);
    }
  } catch {
    /* pairing failed — the device stays unauthenticated until re-paired */
  }
}

/** On first load: consume a `?pair=` code (exchange) or a legacy `?token=`, then strip it from the URL. */
function consumeUrlToken(): void {
  try {
    const url = new URL(window.location.href);
    const pair = url.searchParams.get('pair');
    const legacy = url.searchParams.get('token');
    if (pair) {
      url.searchParams.delete('pair');
      window.history.replaceState({}, document.title, url.toString());
      void exchangePairCode(pair);
    } else if (legacy) {
      sessionStorage.setItem(KEY, legacy);
      url.searchParams.delete('token');
      window.history.replaceState({}, document.title, url.toString());
    }
  } catch {
    /* URL / sessionStorage unavailable */
  }
}

/** Fetch a short-lived WS connect ticket — the device token stays in this POST's header, so only
 *  a 30s token ever appears in the WebSocket URL. Falls back to the stored token (dev). */
export async function wsTicket(): Promise<string | undefined> {
  const token = getToken();
  try {
    const res = await fetch(`${API_BASE}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      if (data.token) return data.token;
    }
  } catch {
    /* fall back to the stored token */
  }
  return token;
}

consumeUrlToken();

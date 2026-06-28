// Device pairing token for the phone companion. The creator opens this surface via a paired
// link (`?token=…`) generated in the dashboard; the token is captured once, persisted to
// sessionStorage, and stripped from the URL so it isn't left in the address bar/history.
// A build-time VITE_GLANCE_TOKEN remains a dev / self-host fallback — never the prod path.
const KEY = 'glance_token';

// Consume a `?token=` from a paired link on first load: persist it, then remove it from the URL.
function consumeUrlToken(): void {
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (token) {
      sessionStorage.setItem(KEY, token);
      url.searchParams.delete('token');
      window.history.replaceState({}, document.title, url.toString());
    }
  } catch {
    /* URL / sessionStorage unavailable */
  }
}
consumeUrlToken();

/** The paired device token: from a prior paired link (sessionStorage), else the dev fallback. */
export function getToken(): string | undefined {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  return (import.meta.env['VITE_GLANCE_TOKEN'] as string | undefined) || undefined;
}

const API_BASE =
  (import.meta.env['VITE_GLANCE_API_URL'] as string | undefined) ??
  `http://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`;

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

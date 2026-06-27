import { getToken } from './deviceToken';

const BASE =
  (import.meta.env['VITE_GLANCE_API_URL'] as string | undefined) ??
  `http://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`;

/**
 * Flag the current moment in the session record ("clip that"). When the channel is
 * on Twitch and linked, the server also creates a real clip and returns its edit URL.
 * Best-effort: returns the clip URL when one was made, else null.
 */
export async function markMoment(): Promise<string | null> {
  try {
    const token = getToken();
    const res = await fetch(`${BASE}/api/mark`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const json = (await res.json()) as { clipUrl?: string };
    return json.clipUrl ?? null;
  } catch {
    return null;
  }
}

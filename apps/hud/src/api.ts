const TOKEN = import.meta.env['VITE_GLANCE_TOKEN'] as string | undefined;
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
    const res = await fetch(`${BASE}/api/mark`, {
      method: 'POST',
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    const json = (await res.json()) as { clipUrl?: string };
    return json.clipUrl ?? null;
  } catch {
    return null;
  }
}

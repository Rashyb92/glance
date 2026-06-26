/**
 * Create a real clip of the broadcaster's live stream via the Twitch Helix API.
 * The creator's OAuth token must carry the `clips:edit` scope. The broadcaster id
 * is resolved from the token itself (GET /helix/users), so a creator always clips
 * their own stream — we never need the channel login. Fails soft (returns
 * { ok:false } rather than throwing) so a flaky API never breaks the "clip that" flow.
 */
export interface ClipResult {
  ok: boolean;
  /** Twitch edit URL — lets the creator trim/title the clip — when one was created. */
  url?: string;
  id?: string;
  error?: string;
}

export async function createTwitchClip(
  clientId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClipResult> {
  try {
    const headers = { authorization: `Bearer ${token}`, 'client-id': clientId };
    const me = await fetchImpl('https://api.twitch.tv/helix/users', { headers });
    if (!me.ok) return { ok: false, error: `users ${me.status}` };
    const mj = (await me.json()) as { data?: Array<{ id?: string }> };
    const broadcasterId = mj.data?.[0]?.id;
    if (!broadcasterId) return { ok: false, error: 'no broadcaster' };
    const res = await fetchImpl(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
      { method: 'POST', headers },
    );
    if (!res.ok) return { ok: false, error: `clips ${res.status}` };
    const cj = (await res.json()) as { data?: Array<{ id?: string; edit_url?: string }> };
    const clip = cj.data?.[0];
    if (!clip?.id) return { ok: false, error: 'no clip' };
    return { ok: true, id: clip.id, url: clip.edit_url ?? `https://clips.twitch.tv/${clip.id}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'clip failed' };
  }
}

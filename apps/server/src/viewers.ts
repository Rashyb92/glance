/**
 * Best-effort live concurrent-viewer counts from each platform's API. Distinct from
 * the active-chatter count (which is derived from messages) — this is the "X watching"
 * figure including lurkers. All functions fail soft (return null) so a flaky API
 * never breaks a session.
 */

export async function kickViewers(
  channel: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetchImpl(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`, {
      headers: { accept: 'application/json', 'user-agent': 'glance/1.0' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { livestream?: { viewer_count?: number } | null };
    return typeof json.livestream?.viewer_count === 'number' ? json.livestream.viewer_count : null;
  } catch {
    return null;
  }
}

export async function twitchViewers(
  channel: string,
  clientId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetchImpl(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`,
      { headers: { authorization: `Bearer ${token}`, 'client-id': clientId } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ viewer_count?: number }> };
    const v = json.data?.[0]?.viewer_count;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

export async function youtubeViewers(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const broadcast = await fetchImpl(
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=id&broadcastStatus=active&broadcastType=all',
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!broadcast.ok) return null;
    const bj = (await broadcast.json()) as { items?: Array<{ id?: string }> };
    const id = bj.items?.[0]?.id;
    if (!id) return null;
    const video = await fetchImpl(
      `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${encodeURIComponent(id)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!video.ok) return null;
    const vj = (await video.json()) as {
      items?: Array<{ liveStreamingDetails?: { concurrentViewers?: string } }>;
    };
    const cv = vj.items?.[0]?.liveStreamingDetails?.concurrentViewers;
    if (cv === undefined) return null;
    const n = Number(cv);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

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

const VAPID_PUBLIC = import.meta.env['VITE_VAPID_PUBLIC_KEY'] as string | undefined;

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Register this device for real background Web Push — alerts arrive even when the
 * companion is closed. No-op without a configured VAPID key or push support.
 */
export async function subscribePush(): Promise<boolean> {
  if (!VAPID_PUBLIC || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
    });
    const json = sub.toJSON();
    const token = getToken();
    const res = await fetch(`${BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ platform: 'webpush', endpoint: json.endpoint, keys: json.keys }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

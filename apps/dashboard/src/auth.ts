// Runtime session auth for the dashboard. A login token is acquired at runtime (stored in
// sessionStorage) and takes precedence over any build-time `VITE_GLANCE_TOKEN` — which is kept
// only as a dev / self-host fallback, never the production path. This is what retires the
// "baked token is public" problem: production builds ship no token.

const KEY = 'glance_token';

/** HTTP API base — also used for the auth endpoints. Set VITE_GLANCE_API_URL in production. */
export const API_BASE =
  (import.meta.env['VITE_GLANCE_API_URL'] as string | undefined) ??
  `http://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`;

/** The active token: a runtime login token if present, else the build-time fallback. */
export function getToken(): string | undefined {
  try {
    const stored = sessionStorage.getItem(KEY);
    if (stored) return stored;
  } catch {
    /* sessionStorage unavailable (e.g. privacy mode) */
  }
  return (import.meta.env['VITE_GLANCE_TOKEN'] as string | undefined) || undefined;
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* ignore */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Revoke this session server-side (best-effort), then clear the local token. */
export async function logout(): Promise<void> {
  const token = getToken();
  if (token) {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      /* best effort — clear locally regardless */
    }
  }
  clearToken();
}

/** Any usable token (runtime login OR dev fallback) — gates the dashboard vs the login screen. */
export function hasSession(): boolean {
  return Boolean(getToken());
}

/** A token obtained via runtime login this session (not the baked fallback) — gates "Sign out". */
export function hasLoginSession(): boolean {
  try {
    return Boolean(sessionStorage.getItem(KEY));
  } catch {
    return false;
  }
}

/** Base URLs of the output surfaces, for generating paired-device links. */
export const HUD_URL =
  (import.meta.env['VITE_HUD_URL'] as string | undefined) ?? 'http://localhost:5173';
export const COMPANION_URL =
  (import.meta.env['VITE_COMPANION_URL'] as string | undefined) ?? 'http://localhost:5175';

/** A paired-device link carrying the current session token (the device captures + strips it). */
export function pairLink(base: string): string {
  const token = getToken();
  if (!token) return base;
  return `${base}${base.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export type AuthResult = { ok: true } | { ok: false; error: string };

export function login(email: string, password: string): Promise<AuthResult> {
  return authRequest('login', email, password);
}

export function signup(email: string, password: string): Promise<AuthResult> {
  return authRequest('signup', email, password);
}

async function authRequest(
  kind: 'login' | 'signup',
  email: string,
  password: string,
): Promise<AuthResult> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = (await res.json()) as { token?: string; error?: string };
    if (!res.ok || !data.token) return { ok: false, error: data.error ?? 'Something went wrong' };
    setToken(data.token);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — is the server running?' };
  }
}

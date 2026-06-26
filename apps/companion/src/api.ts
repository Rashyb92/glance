const TOKEN = import.meta.env['VITE_GLANCE_TOKEN'] as string | undefined;
const BASE =
  (import.meta.env['VITE_GLANCE_API_URL'] as string | undefined) ??
  `http://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`;

/** Flag the current moment in the session record ("clip that"). Best-effort. */
export async function markMoment(): Promise<void> {
  try {
    await fetch(`${BASE}/api/mark`, {
      method: 'POST',
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
  } catch {
    /* offline — ignore */
  }
}

import { test, expect } from '@playwright/test';

// Smoke: the server boots and its ops endpoints respond. Uses the API request fixture (no browser
// needed) so it's fast and non-flaky — the foundation to grow real browser journeys on top of.

test('health endpoint reports ok', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});

test('readiness endpoint is reachable', async ({ request }) => {
  const res = await request.get('/ready');
  expect(res.ok()).toBeTruthy(); // file-store / no DATABASE_URL → ready
});

test('admin console page is served', async ({ request }) => {
  const res = await request.get('/admin');
  expect(res.ok()).toBeTruthy();
  expect((await res.text()).toLowerCase()).toContain('admin');
});

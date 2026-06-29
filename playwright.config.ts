import { defineConfig } from '@playwright/test';

// E2E scaffold. Playwright boots the server (single `start` process, not watch) and waits for
// /health before running specs in ./e2e. Add browser-level journeys (login, connect, surfaced feed)
// alongside the smoke spec. Local runs reuse an already-running server; CI always starts a fresh one.
const PORT = Number(process.env.GLANCE_WS_PORT) || 8787;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm --filter @glance/server start',
    url: `${BASE_URL}/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});

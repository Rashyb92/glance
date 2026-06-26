import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The HUD dev server. It connects to the Glance server's WebSocket gateway
// (default ws://localhost:8787) — override with VITE_GLANCE_WS in apps/hud/.env.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});

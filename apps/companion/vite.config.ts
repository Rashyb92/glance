import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The phone companion dev server. Connects to the Glance gateway WebSocket
// (default ws://localhost:8787) — override with VITE_GLANCE_WS / VITE_GLANCE_WS_URL,
// and VITE_GLANCE_TOKEN to pair to a specific tenant.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
});

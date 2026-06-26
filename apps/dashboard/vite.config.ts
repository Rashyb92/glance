import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Creator Command Center. Runs on 5174 so it can sit alongside the HUD (5173)
// and consume the same Glance gateway (default ws://localhost:8787).
export default defineConfig({
  plugins: [react()],
  server: { port: 5174 },
});

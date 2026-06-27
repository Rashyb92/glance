# Glance server (gateway) container image.
#
# The front-ends (apps/hud, apps/dashboard, apps/companion) deploy as static `vite build`
# output on a CDN/static host (see docs/DEPLOY.md); this image runs the stateful WebSocket +
# REST server and Hub.
#
# The workspace packages export their TypeScript source directly, so the server runs via tsx
# with no compile step. tsx is now a *production* dependency of @glance/server, so the image
# installs production dependencies only — dev tooling (vitest, eslint, typescript, vite, …) is
# excluded, keeping the image small and the runtime surface minimal.
FROM node:24-alpine

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy the whole workspace (node_modules / .data / .git are excluded via .dockerignore) so pnpm
# can resolve every workspace package the lockfile pins, then install production deps only.
COPY . .
RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
ENV GLANCE_WS_PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://localhost:${GLANCE_WS_PORT}/health" || exit 1

CMD ["pnpm", "--filter", "@glance/server", "start"]

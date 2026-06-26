# Glance server (gateway) container image.
#
# The front-ends (apps/hud, apps/dashboard) deploy as static `vite build` output
# on a CDN/static host; this image runs the WebSocket + control-plane server.
#
# Starting image — runs via tsx. For a leaner production image, add a compile step
# (tsx/tsup → JS) and a multi-stage prune; tracked in the deploy milestone.
FROM node:24-alpine

RUN corepack enable
WORKDIR /app

# Install workspace deps first (cached on lockfile changes).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/ai/package.json ./packages/ai/package.json
COPY packages/platforms/package.json ./packages/platforms/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/hud/package.json ./apps/hud/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN pnpm install --frozen-lockfile

# Source needed to run the server.
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server

ENV NODE_ENV=production
ENV GLANCE_WS_PORT=8787
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://localhost:${GLANCE_WS_PORT}/health" || exit 1

CMD ["pnpm", "--filter", "@glance/server", "start"]

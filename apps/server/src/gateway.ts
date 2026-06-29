import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  AnalyticsReport,
  ChannelRef,
  EngineSettings,
  Platform,
  ScoredMessage,
  SessionDetail,
  SessionState,
  SessionSummary,
  TeamMember,
} from '@glance/core';
import { canManageTeam } from '@glance/core';
import type { Bus } from './bus';
import type { PushSubscription } from './push-store';
import { handleIntegrationRoutes, type IntegrationDeps } from './integrations/routes';
import { handleAdminRoutes, type AdminDeps } from './admin/admin-routes';
import { ADMIN_CONSOLE_HTML } from './admin/console-html';
import { resolveActor, signMemberToken } from './auth';
import { RateLimiter } from './ratelimit';
import { logger } from './logger';
import { metrics } from './metrics';

/**
 * The control surface the gateway exposes over HTTP + seeds new WS clients with.
 * Every operation is tenant-scoped: the gateway resolves a client's tenant from its
 * token (see {@link resolveTenant}) and passes it through, so tenants never see each
 * other's sessions, settings, or archives.
 */
export interface GatewayControl {
  getSnapshot: (tenant: string) => ScoredMessage[];
  getSession: (tenant: string) => SessionState;
  connect: (tenant: string, channel: string, demo: boolean, platform: Platform) => SessionState;
  connectMany: (tenant: string, sources: ChannelRef[], demo: boolean) => SessionState;
  disconnect: (tenant: string) => SessionState;
  mark: (tenant: string) => Promise<{ clipUrl?: string }>;
  getSettings: (tenant: string) => EngineSettings;
  updateSettings: (tenant: string, patch: unknown) => EngineSettings;
  listSessions: (tenant: string) => SessionSummary[];
  getReplay: (tenant: string, id: string) => SessionDetail | null;
  deleteReplay: (tenant: string, id: string) => void;
  exportAll: (tenant: string) => SessionDetail[];
  deleteByChannel: (tenant: string, channel: string) => number;
  deleteByAuthor: (tenant: string, author: string) => number;
  eraseSessions: (tenant: string) => number;
  analytics: (tenant: string) => AnalyticsReport | null;
  listTeam: (tenant: string) => TeamMember[] | null;
  inviteMember: (
    tenant: string,
    email: string,
    role: string,
  ) => TeamMember | { error: string } | null;
  removeMember: (tenant: string, id: string) => boolean | null;
  revokeMember: (tenant: string, memberId: string) => boolean | null;
  memberActive: (tenant: string, memberId: string) => boolean;
  sessionActive: (tenant: string, sessionId: string, issuedAt: number) => boolean;
  listPush: (tenant: string) => PushSubscription[];
  subscribePush: (
    tenant: string,
    platform: string,
    endpoint: string,
    keys?: { p256dh: string; auth: string },
  ) => PushSubscription | { error: string };
  removePush: (tenant: string, id: string) => boolean;
}

export interface Gateway {
  clientCount: () => number;
  close: () => void;
}

// ---------------------------------------------------------------------------
// Hardening config (env-overridable). Defaults are safe for local dev.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (
  process.env['GLANCE_ALLOWED_ORIGINS'] ??
  'http://localhost:5173,http://localhost:5174,http://localhost:5175'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_CLIENTS = intEnv('GLANCE_MAX_CLIENTS', 500);
const MAX_CLIENTS_PER_TENANT = intEnv('GLANCE_MAX_CLIENTS_PER_TENANT', 50);
const MAX_WS_PAYLOAD = intEnv('GLANCE_MAX_WS_PAYLOAD', 64 * 1024); // 64 KB/frame
const MAX_BODY_BYTES = intEnv('GLANCE_MAX_BODY_BYTES', 256 * 1024); // 256 KB REST body
const MAX_BUFFERED = intEnv('GLANCE_MAX_BUFFERED', 1024 * 1024); // 1 MB per-client send buffer
const HEARTBEAT_MS = 30_000;

type TrackedSocket = WebSocket & { isAlive?: boolean; tenant?: string };

/**
 * The render-target transport + control plane. Streams `ServerMessage`s to every
 * authorized client over WebSocket and exposes a small REST API to drive sessions.
 *
 * Multi-tenant: each socket joins a room keyed by its resolved tenant, and outbound
 * messages arrive via the {@link Bus} (one subscription, fanned out per room) so the
 * design scales to many gateway instances behind a shared bus.
 *
 * Hardened: origin allowlist + reflected CORS, token-gated tenant resolution,
 * per-frame payload cap, connection cap, ping/pong heartbeat (drops zombie sockets),
 * and per-client backpressure (skips slow consumers instead of buffering unboundedly).
 */
export function startGateway(
  port: number,
  control: GatewayControl,
  bus: Bus,
  integrations?: IntegrationDeps,
  readiness?: () => Promise<boolean>,
  admin?: AdminDeps,
): Gateway {
  // Per-IP token buckets: cheap protection against floods / accidental loops.
  const httpLimiter = new RateLimiter(
    intEnv('GLANCE_HTTP_BURST', 60),
    intEnv('GLANCE_HTTP_RPS', 20),
  );
  const connLimiter = new RateLimiter(
    intEnv('GLANCE_CONN_BURST', 20),
    intEnv('GLANCE_CONN_RPS', 5),
  );
  const server = createServer((req, res) =>
    handleHttp(req, res, control, httpLimiter, integrations, readiness, admin),
  );
  // Slowloris defense: cap how long a client may take to send headers / the full request.
  server.headersTimeout = intEnv('GLANCE_HEADERS_TIMEOUT_MS', 20_000);
  server.requestTimeout = intEnv('GLANCE_REQUEST_TIMEOUT_MS', 30_000);

  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_WS_PAYLOAD,
    verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) =>
      originAllowed(info.origin),
  });

  // tenant -> sockets in that tenant's room.
  const rooms = new Map<string, Set<TrackedSocket>>();
  const join = (tenant: string, socket: TrackedSocket): void => {
    let room = rooms.get(tenant);
    if (!room) {
      room = new Set();
      rooms.set(tenant, room);
    }
    room.add(socket);
  };
  const leave = (tenant: string, socket: TrackedSocket): void => {
    const room = rooms.get(tenant);
    if (!room) return;
    room.delete(socket);
    if (room.size === 0) rooms.delete(tenant);
  };

  metrics.gauge('glance_ws_clients', () => wss.clients.size);
  metrics.gauge('glance_ws_rooms', () => rooms.size);

  // Single outbound path: tenant controllers publish to the bus; we fan out to the
  // matching room. Swapping InProcessBus for Redis makes this multi-instance safe.
  bus.subscribe((tenant, message) => {
    const room = rooms.get(tenant);
    if (!room || room.size === 0) return;
    metrics.inc('glance_broadcasts_total');
    const payload = JSON.stringify(message);
    for (const socket of room) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > MAX_BUFFERED) continue; // skip a slow consumer
      try {
        socket.send(payload);
      } catch {
        /* a single failed send must not stop the broadcast */
      }
    }
  });

  wss.on('connection', (socket: TrackedSocket, req: IncomingMessage) => {
    if (wss.clients.size > MAX_CLIENTS) {
      logger.warn('ws connection refused: at capacity', { max: MAX_CLIENTS });
      metrics.inc('glance_ws_refused_total');
      socket.close(1013, 'at capacity');
      return;
    }

    if (!connLimiter.allow(clientIp(req))) {
      metrics.inc('glance_ws_ratelimited_total');
      socket.close(1013, 'rate limited');
      return;
    }

    const actor = resolveActor(tokenFromUrl(req.url));
    if (
      !actor ||
      (actor.memberId && !control.memberActive(actor.tenant, actor.memberId)) ||
      (actor.sessionId &&
        !control.sessionActive(actor.tenant, actor.sessionId, actor.issuedAt ?? 0))
    ) {
      metrics.inc('glance_ws_unauthorized_total');
      socket.close(1008, 'unauthorized');
      return;
    }
    const tenant = actor.tenant;

    // Per-tenant connection cap, so one tenant can't exhaust the global pool.
    const existingRoom = rooms.get(tenant);
    if (existingRoom && existingRoom.size >= MAX_CLIENTS_PER_TENANT) {
      metrics.inc('glance_ws_tenant_capacity_total');
      socket.close(1013, 'tenant at capacity');
      return;
    }

    socket.tenant = tenant;
    join(tenant, socket);
    metrics.inc('glance_ws_connections_total');
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => leave(tenant, socket));

    safeSend(socket, JSON.stringify({ type: 'hello', data: { ts: Date.now() } }));
    safeSend(socket, JSON.stringify({ type: 'session', data: control.getSession(tenant) }));
    safeSend(socket, JSON.stringify({ type: 'settings', data: control.getSettings(tenant) }));
    for (const scored of control.getSnapshot(tenant)) {
      safeSend(socket, JSON.stringify({ type: 'message', data: scored }));
    }
  });

  // Drop half-open / zombie connections so they don't leak memory + fan-out cost.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const s = client as TrackedSocket;
      if (s.isAlive === false) {
        s.terminate();
        continue;
      }
      s.isAlive = false;
      try {
        s.ping();
      } catch {
        s.terminate();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // Reclaim idle rate-limit buckets so the maps can't grow unbounded.
  const sweeper = setInterval(() => {
    httpLimiter.sweep();
    connLimiter.sweep();
  }, 60_000);
  sweeper.unref?.();

  server.listen(port);

  return {
    clientCount: () => wss.clients.size,
    close: () => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const client of wss.clients) client.close(1001, 'server shutting down');
      wss.close();
      server.closeAllConnections?.(); // drop lingering keep-alive sockets (Node 18.2+)
      server.close();
    },
  };
}

// Per-tenant cooldown on clip/mark — Twitch clip creation is rate-limited upstream and a hot path
// for abuse. Override with GLANCE_CLIP_COOLDOWN_MS.
const MARK_COOLDOWN_MS = Number(process.env['GLANCE_CLIP_COOLDOWN_MS']) || 15_000;
const markCooldown = new Map<string, number>();

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  control: GatewayControl,
  limiter: RateLimiter,
  integrations?: IntegrationDeps,
  readiness?: () => Promise<boolean>,
  admin?: AdminDeps,
): void {
  const cors = { ...corsHeaders(req.headers.origin), ...securityHeaders() };
  const send = (code: number, body?: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', ...cors });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = (req.url ?? '').split('?')[0] ?? '';

  // Metrics: open by default (Prometheus scrapes behind a private network); when
  // GLANCE_METRICS_TOKEN is set, require it (Bearer or `?token=`) so a public deploy can lock it down.
  if (req.method === 'GET' && url === '/metrics') {
    const metricsToken = process.env['GLANCE_METRICS_TOKEN'];
    if (metricsToken && tokenFromReq(req) !== metricsToken) {
      send(401, { error: 'unauthorized' });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', ...cors });
    res.end(metrics.render());
    return;
  }
  // Liveness: the process is up. Always 200 — k8s/Fly restart the container on failure.
  if (req.method === 'GET' && url === '/health') {
    send(200, { ok: true });
    return;
  }
  // Readiness: only accept traffic once the durable deps (Postgres) are reachable. 503 holds the
  // instance out of rotation until they are.
  if (req.method === 'GET' && url === '/ready') {
    if (!readiness) {
      send(200, { ready: true });
      return;
    }
    void readiness()
      .then((ok) => send(ok ? 200 : 503, { ready: ok }))
      .catch(() => send(503, { ready: false }));
    return;
  }
  // Admin/support console UI — a static page (just a login form); the operator pastes their token,
  // which rides as a Bearer header to the operator-gated API below. The API stays locked when admin
  // is unconfigured, so serving the page is harmless.
  if (admin && req.method === 'GET' && (url === '/admin' || url === '/admin/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors });
    res.end(ADMIN_CONSOLE_HTML);
    return;
  }

  // Rate-limit the data plane (ops endpoints above are intentionally exempt).
  const ip = clientIp(req);
  if (!limiter.allow(ip)) {
    metrics.inc('glance_http_ratelimited_total');
    send(429, { error: 'rate_limited' });
    return;
  }

  // OAuth / billing routes — some are token-less (OAuth callback + Stripe webhook),
  // so they're handled before the tenant gate below.
  if (integrations && handleIntegrationRoutes(req, res, url, cors, integrations)) {
    return;
  }

  // Admin/support console API — operator-gated (a separate trust domain), handled before the tenant
  // gate since operators don't carry tenant tokens. Rate-limited like the data plane to slow token
  // brute-force.
  if (admin && handleAdminRoutes(req, res, url, cors, admin, ip)) {
    return;
  }

  // Everything below is tenant-scoped and requires a resolvable token. Member tokens
  // additionally carry a team role, used to gate team-management actions below.
  const actor = resolveActor(tokenFromReq(req));
  if (!actor) {
    send(401, { error: 'unauthorized' });
    return;
  }
  // Member tokens are revoked when removed from the roster; owner session tokens when the user
  // logs out or revokes all sessions (stolen-token kill switch).
  if (
    (actor.memberId && !control.memberActive(actor.tenant, actor.memberId)) ||
    (actor.sessionId && !control.sessionActive(actor.tenant, actor.sessionId, actor.issuedAt ?? 0))
  ) {
    send(401, { error: 'unauthorized' });
    return;
  }
  const tenant = actor.tenant;

  if (url === '/api/session') {
    if (req.method === 'GET') return send(200, control.getSession(tenant));
    if (req.method === 'DELETE') return send(200, control.disconnect(tenant));
    if (req.method === 'POST') {
      readJson(req)
        .then((body) => {
          const demo = body['demo'] !== false;
          send(200, control.connectMany(tenant, parseChannels(body), demo));
        })
        .catch((err: Error) =>
          send(err.message === 'too_large' ? 413 : 400, { error: err.message }),
        );
      return;
    }
  }
  if (url === '/api/settings') {
    if (req.method === 'GET') return send(200, control.getSettings(tenant));
    if (req.method === 'POST' || req.method === 'PUT') {
      readJson(req)
        .then((body) => send(200, control.updateSettings(tenant, body)))
        .catch((err: Error) =>
          send(err.message === 'too_large' ? 413 : 400, { error: err.message }),
        );
      return;
    }
  }
  if (url === '/api/mark' && req.method === 'POST') {
    const now = Date.now();
    if (now - (markCooldown.get(tenant) ?? 0) < MARK_COOLDOWN_MS) {
      send(429, { error: 'clip cooldown — try again in a moment' });
      return;
    }
    markCooldown.set(tenant, now);
    control
      .mark(tenant)
      .then((result) => send(200, { ok: true, ...result }))
      .catch(() => send(200, { ok: true }));
    return;
  }
  if (url === '/api/export') {
    if (req.method === 'GET') return send(200, control.exportAll(tenant));
  }
  if (url === '/api/analytics') {
    if (req.method === 'GET') {
      const report = control.analytics(tenant);
      return send(
        report ? 200 : 403,
        report ?? { error: 'advanced analytics is not on your plan' },
      );
    }
  }
  if (url === '/api/team') {
    if (req.method === 'GET') {
      const members = control.listTeam(tenant);
      return send(members ? 200 : 403, members ?? { error: 'team management is not on your plan' });
    }
    if (req.method === 'POST') {
      if (!canManageTeam(actor.role)) return send(403, { error: 'admins only' });
      readJson(req)
        .then((body) => {
          const result = control.inviteMember(
            tenant,
            typeof body['email'] === 'string' ? body['email'] : '',
            typeof body['role'] === 'string' ? body['role'] : 'member',
          );
          if (result === null) return send(403, { error: 'team management is not on your plan' });
          if ('error' in result) return send(400, result);
          return send(200, result);
        })
        .catch((err: Error) =>
          send(err.message === 'too_large' ? 413 : 400, { error: err.message }),
        );
      return;
    }
  }
  if (url.startsWith('/api/team/')) {
    const rest = url.slice('/api/team/'.length);
    // POST /api/team/:id/login — mint a per-member login token (admins / owners only).
    if (rest.endsWith('/login') && req.method === 'POST') {
      if (!canManageTeam(actor.role)) return send(403, { error: 'admins only' });
      const secret = process.env['GLANCE_AUTH_SECRET'];
      if (!secret) return send(501, { error: 'member logins require GLANCE_AUTH_SECRET' });
      const members = control.listTeam(tenant);
      if (members === null) return send(403, { error: 'team management is not on your plan' });
      const memberId = decodeURIComponent(rest.slice(0, -'/login'.length));
      const member = members.find((m) => m.id === memberId);
      if (!member) return send(404, { error: 'member not found' });
      return send(200, {
        // 30-day TTL bounds exposure; removal revokes it immediately via memberActive().
        token: signMemberToken(tenant, member.id, member.role, secret, {
          ttlSeconds: 60 * 60 * 24 * 30,
        }),
        role: member.role,
      });
    }
    // POST /api/team/:id/revoke — force-logout a member without removing them.
    if (rest.endsWith('/revoke') && req.method === 'POST') {
      if (!canManageTeam(actor.role)) return send(403, { error: 'admins only' });
      const memberId = decodeURIComponent(rest.slice(0, -'/revoke'.length));
      const ok = control.revokeMember(tenant, memberId);
      if (ok === null) return send(403, { error: 'not on your plan' });
      if (!ok) return send(404, { error: 'member not found' });
      return send(200, { ok: true });
    }
    if (req.method === 'DELETE') {
      if (!canManageTeam(actor.role)) return send(403, { error: 'admins only' });
      const id = decodeURIComponent(rest);
      const ok = control.removeMember(tenant, id);
      return send(ok === null ? 403 : 200, ok === null ? { error: 'not on your plan' } : { ok });
    }
  }
  if (url === '/api/push') {
    if (req.method === 'GET') return send(200, control.listPush(tenant));
  }
  if (url === '/api/push/subscribe') {
    if (req.method === 'POST') {
      readJson(req)
        .then((body) => {
          const result = control.subscribePush(
            tenant,
            typeof body['platform'] === 'string' ? body['platform'] : '',
            typeof body['endpoint'] === 'string' ? body['endpoint'] : '',
            parsePushKeys(body['keys']),
          );
          return send('error' in result ? 400 : 200, result);
        })
        .catch((err: Error) =>
          send(err.message === 'too_large' ? 413 : 400, { error: err.message }),
        );
      return;
    }
  }
  if (url.startsWith('/api/push/') && url !== '/api/push/subscribe') {
    const id = decodeURIComponent(url.slice('/api/push/'.length));
    if (req.method === 'DELETE') return send(200, { ok: control.removePush(tenant, id) });
  }
  if (url === '/api/sessions') {
    if (req.method === 'GET') return send(200, control.listSessions(tenant));
    if (req.method === 'DELETE') {
      const channel = queryParam(req.url, 'channel');
      if (channel) return send(200, { removed: control.deleteByChannel(tenant, channel) });
      if (queryParam(req.url, 'all') === '1') {
        return send(200, { removed: control.eraseSessions(tenant) }); // DSAR: erase all archives
      }
      return send(400, { error: 'channel or all=1 required' });
    }
  }
  // DSAR: scrub a chatter's attributed content from this tenant's archives.
  if (url.startsWith('/api/author/')) {
    const author = decodeURIComponent(url.slice('/api/author/'.length));
    if (req.method === 'DELETE') {
      return send(200, { changed: control.deleteByAuthor(tenant, author) });
    }
  }
  if (url.startsWith('/api/sessions/')) {
    const id = decodeURIComponent(url.slice('/api/sessions/'.length));
    if (req.method === 'GET') {
      const detail = control.getReplay(tenant, id);
      return send(detail ? 200 : 404, detail ?? { error: 'not found' });
    }
    if (req.method === 'DELETE') {
      control.deleteReplay(tenant, id);
      return send(200, { ok: true });
    }
  }
  send(404, { error: 'not found' });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('too_large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', () => reject(new Error('request_error')));
  });
}

/** Parse Web Push subscription keys (p256dh + auth) from a request body. */
function parsePushKeys(value: unknown): { p256dh: string; auth: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const p256dh = typeof o['p256dh'] === 'string' ? o['p256dh'] : '';
  const auth = typeof o['auth'] === 'string' ? o['auth'] : '';
  return p256dh && auth ? { p256dh, auth } : undefined;
}

/** Validate a connect request's platform (defaults to twitch). */
function connectPlatform(value: unknown): Platform {
  return value === 'youtube' || value === 'kick' ? value : 'twitch';
}

/**
 * Parse a connect body into source channels. Accepts either a `channels` array
 * (unified multi-channel) or a single `channel` + `platform` (back-compat).
 */
export function parseChannels(body: Record<string, unknown>): ChannelRef[] {
  const raw = body['channels'];
  if (Array.isArray(raw)) {
    const out: ChannelRef[] = [];
    for (const item of raw.slice(0, 50)) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const channel = typeof o['channel'] === 'string' ? o['channel'] : '';
        if (channel.trim()) out.push({ platform: connectPlatform(o['platform']), channel });
      }
    }
    return out;
  }
  const channel = typeof body['channel'] === 'string' ? body['channel'] : '';
  return channel.trim() ? [{ platform: connectPlatform(body['platform']), channel }] : [];
}

/** Extract a named query param from a request URL. */
function queryParam(url: string | undefined, name: string): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  return new URLSearchParams(url.slice(q + 1)).get(name) ?? undefined;
}

/** Extract the `token` query param (used by browser WS clients). */
function tokenFromUrl(url: string | undefined): string | undefined {
  return queryParam(url, 'token');
}

/** Extract a token from `Authorization: Bearer …` or the `token` query param. */
function tokenFromReq(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return tokenFromUrl(req.url);
}

/**
 * Best-effort client IP for rate limiting. Only trusts `X-Forwarded-For` when
 * `GLANCE_TRUST_PROXY=1` (i.e. you run behind a known LB) — otherwise a client
 * could spoof the header to evade limits.
 */
function clientIp(req: IncomingMessage): string {
  if (process.env['GLANCE_TRUST_PROXY'] === '1') {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function originAllowed(origin: string | undefined): boolean {
  // Non-browser clients (native overlays, CLI) send no Origin — allow those.
  // Browsers always send Origin, so a malicious site is blocked by the allowlist.
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
}

export function corsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    vary: 'Origin',
  };
  if (origin && originAllowed(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

/** Security headers applied to every HTTP response (HSTS is added only in production). */
export function securityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  };
  if (process.env['NODE_ENV'] === 'production') {
    headers['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
  }
  return headers;
}

function safeSend(socket: WebSocket, payload: string): void {
  try {
    socket.send(payload);
  } catch {
    /* ignore a failed seed send */
  }
}

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

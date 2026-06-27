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
import type { Bus } from './bus';
import type { PushSubscription } from './push-store';
import { handleIntegrationRoutes, type IntegrationDeps } from './integrations/routes';
import { resolveTenant } from './auth';
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
  analytics: (tenant: string) => AnalyticsReport | null;
  listTeam: (tenant: string) => TeamMember[] | null;
  inviteMember: (
    tenant: string,
    email: string,
    role: string,
  ) => TeamMember | { error: string } | null;
  removeMember: (tenant: string, id: string) => boolean | null;
  listPush: (tenant: string) => PushSubscription[];
  subscribePush: (
    tenant: string,
    platform: string,
    endpoint: string,
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
): Gateway {
  // Per-IP token buckets: cheap protection against floods / accidental loops.
  const httpLimiter = new RateLimiter(intEnv('GLANCE_HTTP_BURST', 60), intEnv('GLANCE_HTTP_RPS', 20));
  const connLimiter = new RateLimiter(intEnv('GLANCE_CONN_BURST', 20), intEnv('GLANCE_CONN_RPS', 5));
  const server = createServer((req, res) => handleHttp(req, res, control, httpLimiter, integrations));

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

    const tenant = resolveTenant(tokenFromUrl(req.url));
    if (!tenant) {
      metrics.inc('glance_ws_unauthorized_total');
      socket.close(1008, 'unauthorized');
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
      server.close();
    },
  };
}

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  control: GatewayControl,
  limiter: RateLimiter,
  integrations?: IntegrationDeps,
): void {
  const cors = corsHeaders(req.headers.origin);
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

  // Ops endpoints are unauthenticated by design (scraped by Prometheus / k8s probes).
  if (req.method === 'GET' && url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', ...cors });
    res.end(metrics.render());
    return;
  }
  if (req.method === 'GET' && url === '/health') {
    send(200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url === '/ready') {
    send(200, { ready: true });
    return;
  }

  // Rate-limit the data plane (ops endpoints above are intentionally exempt).
  if (!limiter.allow(clientIp(req))) {
    metrics.inc('glance_http_ratelimited_total');
    send(429, { error: 'rate_limited' });
    return;
  }

  // OAuth / billing routes — some are token-less (OAuth callback + Stripe webhook),
  // so they're handled before the tenant gate below.
  if (integrations && handleIntegrationRoutes(req, res, url, cors, integrations)) {
    return;
  }

  // Everything below is tenant-scoped and requires a resolvable token.
  const tenant = resolveTenant(tokenFromReq(req));
  if (!tenant) {
    send(401, { error: 'unauthorized' });
    return;
  }

  if (url === '/api/session') {
    if (req.method === 'GET') return send(200, control.getSession(tenant));
    if (req.method === 'DELETE') return send(200, control.disconnect(tenant));
    if (req.method === 'POST') {
      readJson(req)
        .then((body) => {
          const demo = body['demo'] !== false;
          send(200, control.connectMany(tenant, parseChannels(body), demo));
        })
        .catch((err: Error) => send(err.message === 'too_large' ? 413 : 400, { error: err.message }));
      return;
    }
  }
  if (url === '/api/settings') {
    if (req.method === 'GET') return send(200, control.getSettings(tenant));
    if (req.method === 'POST' || req.method === 'PUT') {
      readJson(req)
        .then((body) => send(200, control.updateSettings(tenant, body)))
        .catch((err: Error) => send(err.message === 'too_large' ? 413 : 400, { error: err.message }));
      return;
    }
  }
  if (url === '/api/mark' && req.method === 'POST') {
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
      return send(report ? 200 : 403, report ?? { error: 'advanced analytics is not on your plan' });
    }
  }
  if (url === '/api/team') {
    if (req.method === 'GET') {
      const members = control.listTeam(tenant);
      return send(members ? 200 : 403, members ?? { error: 'team management is not on your plan' });
    }
    if (req.method === 'POST') {
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
        .catch((err: Error) => send(err.message === 'too_large' ? 413 : 400, { error: err.message }));
      return;
    }
  }
  if (url.startsWith('/api/team/')) {
    const id = decodeURIComponent(url.slice('/api/team/'.length));
    if (req.method === 'DELETE') {
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
          );
          return send('error' in result ? 400 : 200, result);
        })
        .catch((err: Error) => send(err.message === 'too_large' ? 413 : 400, { error: err.message }));
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
      if (!channel) return send(400, { error: 'channel required' });
      return send(200, { removed: control.deleteByChannel(tenant, channel) });
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
    for (const item of raw) {
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

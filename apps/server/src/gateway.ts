import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  EngineSettings,
  ScoredMessage,
  SessionDetail,
  SessionState,
  SessionSummary,
} from '@glance/core';
import type { Bus } from './bus';
import { resolveTenant } from './auth';
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
  connect: (tenant: string, channel: string, demo: boolean) => SessionState;
  disconnect: (tenant: string) => SessionState;
  getSettings: (tenant: string) => EngineSettings;
  updateSettings: (tenant: string, patch: unknown) => EngineSettings;
  listSessions: (tenant: string) => SessionSummary[];
  getReplay: (tenant: string, id: string) => SessionDetail | null;
  deleteReplay: (tenant: string, id: string) => void;
}

export interface Gateway {
  clientCount: () => number;
  close: () => void;
}

// ---------------------------------------------------------------------------
// Hardening config (env-overridable). Defaults are safe for local dev.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (
  process.env['GLANCE_ALLOWED_ORIGINS'] ?? 'http://localhost:5173,http://localhost:5174'
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
export function startGateway(port: number, control: GatewayControl, bus: Bus): Gateway {
  const server = createServer((req, res) => handleHttp(req, res, control));

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

  server.listen(port);

  return {
    clientCount: () => wss.clients.size,
    close: () => {
      clearInterval(heartbeat);
      for (const client of wss.clients) client.close(1001, 'server shutting down');
      wss.close();
      server.close();
    },
  };
}

function handleHttp(req: IncomingMessage, res: ServerResponse, control: GatewayControl): void {
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
          const channel = typeof body['channel'] === 'string' ? body['channel'] : '';
          const demo = body['demo'] !== false;
          send(200, control.connect(tenant, channel, demo));
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
  if (url === '/api/sessions') {
    if (req.method === 'GET') return send(200, control.listSessions(tenant));
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

/** Extract the `token` query param from a request URL (used by browser WS clients). */
function tokenFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  return new URLSearchParams(url.slice(q + 1)).get('token') ?? undefined;
}

/** Extract a token from `Authorization: Bearer …` or the `token` query param. */
function tokenFromReq(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return tokenFromUrl(req.url);
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

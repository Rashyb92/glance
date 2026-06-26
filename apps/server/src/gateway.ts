import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  EngineSettings,
  ScoredMessage,
  ServerMessage,
  SessionDetail,
  SessionState,
  SessionSummary,
} from '@glance/core';

/** The control surface the gateway exposes over HTTP + seeds new WS clients with. */
export interface GatewayControl {
  getSnapshot: () => ScoredMessage[];
  getSession: () => SessionState;
  connect: (channel: string, demo: boolean) => SessionState;
  disconnect: () => SessionState;
  getSettings: () => EngineSettings;
  updateSettings: (patch: unknown) => EngineSettings;
  listSessions: () => SessionSummary[];
  getReplay: (id: string) => SessionDetail | null;
  deleteReplay: (id: string) => void;
}

export interface Gateway {
  broadcast: (message: ServerMessage) => void;
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

type TrackedSocket = WebSocket & { isAlive?: boolean };

/**
 * The render-target transport + control plane. Streams `ServerMessage`s to every
 * authorized client over WebSocket and exposes a small REST API to drive sessions.
 *
 * Hardened (audit Batch 1): origin allowlist + reflected CORS, per-frame payload
 * cap, connection cap, ping/pong heartbeat (drops zombie sockets), and per-client
 * backpressure (skips slow consumers instead of buffering unboundedly).
 */
export function startGateway(port: number, control: GatewayControl): Gateway {
  const server = createServer((req, res) => handleHttp(req, res, control));

  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_WS_PAYLOAD,
    verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) =>
      originAllowed(info.origin),
  });

  wss.on('connection', (socket: TrackedSocket) => {
    if (wss.clients.size > MAX_CLIENTS) {
      socket.close(1013, 'at capacity');
      return;
    }
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('error', () => socket.terminate());

    safeSend(socket, JSON.stringify({ type: 'hello', data: { ts: Date.now() } }));
    safeSend(socket, JSON.stringify({ type: 'session', data: control.getSession() }));
    safeSend(socket, JSON.stringify({ type: 'settings', data: control.getSettings() }));
    for (const scored of control.getSnapshot()) {
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
    broadcast: (message: ServerMessage) => {
      const payload = JSON.stringify(message);
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (client.bufferedAmount > MAX_BUFFERED) continue; // skip a slow consumer
        try {
          client.send(payload);
        } catch {
          /* a single failed send must not stop the broadcast */
        }
      }
    },
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
  if (req.method === 'GET' && url === '/health') {
    send(200, { ok: true, clients: 0 });
    return;
  }

  if (url === '/api/session') {
    if (req.method === 'GET') return send(200, control.getSession());
    if (req.method === 'DELETE') return send(200, control.disconnect());
    if (req.method === 'POST') {
      readJson(req)
        .then((body) => {
          const channel = typeof body['channel'] === 'string' ? body['channel'] : '';
          const demo = body['demo'] !== false;
          send(200, control.connect(channel, demo));
        })
        .catch((err: Error) => send(err.message === 'too_large' ? 413 : 400, { error: err.message }));
      return;
    }
  }
  if (url === '/api/settings') {
    if (req.method === 'GET') return send(200, control.getSettings());
    if (req.method === 'POST' || req.method === 'PUT') {
      readJson(req)
        .then((body) => send(200, control.updateSettings(body)))
        .catch((err: Error) => send(err.message === 'too_large' ? 413 : 400, { error: err.message }));
      return;
    }
  }
  if (url === '/api/sessions') {
    if (req.method === 'GET') return send(200, control.listSessions());
  }
  if (url.startsWith('/api/sessions/')) {
    const id = decodeURIComponent(url.slice('/api/sessions/'.length));
    if (req.method === 'GET') {
      const detail = control.getReplay(id);
      return send(detail ? 200 : 404, detail ?? { error: 'not found' });
    }
    if (req.method === 'DELETE') {
      control.deleteReplay(id);
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

function originAllowed(origin: string | undefined): boolean {
  // Non-browser clients (native overlays, CLI) send no Origin — allow those.
  // Browsers always send Origin, so a malicious site is blocked by the allowlist.
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
}

function corsHeaders(origin: string | undefined): Record<string, string> {
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

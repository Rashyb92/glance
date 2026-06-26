import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { EngineSettings, ScoredMessage, ServerMessage, SessionState } from '@glance/core';

/** The control surface the gateway exposes over HTTP + seeds new WS clients with. */
export interface GatewayControl {
  getSnapshot: () => ScoredMessage[];
  getSession: () => SessionState;
  connect: (channel: string, demo: boolean) => SessionState;
  disconnect: () => SessionState;
  getSettings: () => EngineSettings;
  updateSettings: (patch: unknown) => EngineSettings;
}

export interface Gateway {
  broadcast: (message: ServerMessage) => void;
  clientCount: () => number;
  close: () => void;
}

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/**
 * The render-target transport + control plane. Streams `ServerMessage`s to every
 * connected client over WebSocket, and exposes a small REST API to drive sessions
 * (`/api/session`) plus `GET /health`.
 */
export function startGateway(port: number, control: GatewayControl): Gateway {
  const server = createServer((req, res) => handleHttp(req, res, control));
  const wss = new WebSocketServer({ server });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', data: { ts: Date.now() } }));
    socket.send(JSON.stringify({ type: 'session', data: control.getSession() }));
    socket.send(JSON.stringify({ type: 'settings', data: control.getSettings() }));
    for (const scored of control.getSnapshot()) {
      socket.send(JSON.stringify({ type: 'message', data: scored }));
    }
  });

  server.listen(port);

  return {
    broadcast: (message: ServerMessage) => {
      const payload = JSON.stringify(message);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    },
    clientCount: () => wss.clients.size,
    close: () => {
      wss.close();
      server.close();
    },
  };
}

function handleHttp(req: IncomingMessage, res: ServerResponse, control: GatewayControl): void {
  const send = (code: number, body?: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json', ...CORS });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/health') {
    send(200, { ok: true });
    return;
  }
  if (url === '/api/session') {
    if (req.method === 'GET') {
      send(200, control.getSession());
      return;
    }
    if (req.method === 'DELETE') {
      send(200, control.disconnect());
      return;
    }
    if (req.method === 'POST') {
      readJson(req)
        .then((body) => {
          const channel = typeof body['channel'] === 'string' ? body['channel'] : '';
          const demo = body['demo'] !== false;
          send(200, control.connect(channel, demo));
        })
        .catch(() => send(400, { error: 'bad request' }));
      return;
    }
  }
  if (url === '/api/settings') {
    if (req.method === 'GET') {
      send(200, control.getSettings());
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      readJson(req)
        .then((body) => send(200, control.updateSettings(body)))
        .catch(() => send(400, { error: 'bad request' }));
      return;
    }
  }
  send(404, { error: 'not found' });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

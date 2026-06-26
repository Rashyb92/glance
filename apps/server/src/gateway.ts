import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ScoredMessage, ServerMessage } from '@glance/core';

export interface Gateway {
  broadcast: (message: ServerMessage) => void;
  clientCount: () => number;
  close: () => void;
}

/**
 * The render-target transport. Streams JSON `ServerMessage`s (scored messages,
 * events, AI summaries, dashboard stats) to every connected client over WebSocket
 * and answers `GET /health`. The same contract will later feed a Meta Ray-Ban
 * Display web app or a Brilliant Labs companion app unchanged.
 */
export function startGateway(port: number, getSnapshot: () => ScoredMessage[]): Gateway {
  const http = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clients: wss.clients.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', data: { ts: Date.now() } }));
    // Seed the freshly opened client with recent context so it is never empty.
    for (const scored of getSnapshot()) {
      socket.send(JSON.stringify({ type: 'message', data: scored }));
    }
  });

  http.listen(port);

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
      http.close();
    },
  };
}

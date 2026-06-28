import { useEffect, useRef, useState } from 'react';
import type {
  ChatSummary,
  DashboardStats,
  EngineSettings,
  PriorityCallout,
  ScoredMessage,
  ServerMessage,
  SessionState,
} from '@glance/core';
import { wsTicket } from './auth';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface DashState {
  status: ConnectionStatus;
  stats: DashboardStats | null;
  summary: ChatSummary | null;
  ticker: ScoredMessage[];
  session: SessionState | null;
  settings: EngineSettings | null;
  priorities: PriorityCallout[];
}

// The WS base; the tenant token is appended at connect time (runtime login token, with the
// build-time VITE_GLANCE_TOKEN as a dev fallback) — never baked into the production bundle.
const WS_BASE =
  (import.meta.env['VITE_GLANCE_WS_URL'] as string | undefined) ??
  `ws://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`;
function wsUrl(token: string | undefined): string {
  if (!token) return WS_BASE;
  return `${WS_BASE}${WS_BASE.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Subscribes to the gateway and exposes the latest stats, AI summary, session
 *  state, engine settings, AI priorities and a small ticker of high-salience messages. */
export function useStats(): DashState {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [summary, setSummary] = useState<ChatSummary | null>(null);
  const [ticker, setTicker] = useState<ScoredMessage[]>([]);
  const [session, setSession] = useState<SessionState | null>(null);
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [priorities, setPriorities] = useState<PriorityCallout[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const open = (ticket: string | undefined): void => {
      if (closedByUs) return;
      const ws = new WebSocket(wsUrl(ticket));
      wsRef.current = ws;
      ws.onopen = () => setStatus('online');
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        setStatus('offline');
        if (!closedByUs) retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (ev: MessageEvent) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'stats':
            setStats(msg.data);
            break;
          case 'summary':
            setSummary(msg.data);
            break;
          case 'session':
            setSession(msg.data);
            break;
          case 'settings':
            setSettings(msg.data);
            break;
          case 'priorities':
            setPriorities(msg.data);
            break;
          case 'message':
            if (msg.data.score >= 0.5) setTicker((p) => [msg.data, ...p].slice(0, 8));
            break;
          default:
            break;
        }
      };
    };
    const connect = (): void => {
      setStatus((s) => (s === 'online' ? s : 'connecting'));
      void wsTicket().then(open);
    };

    connect();
    return () => {
      closedByUs = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  return { status, stats, summary, ticker, session, settings, priorities };
}

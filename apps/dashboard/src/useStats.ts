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

// VITE_GLANCE_TOKEN selects the tenant (absent → the server's `default` tenant).
const WS_TOKEN = import.meta.env['VITE_GLANCE_TOKEN'] as string | undefined;
function withToken(url: string): string {
  if (!WS_TOKEN) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(WS_TOKEN)}`;
}
const WS_URL = withToken(
  (import.meta.env['VITE_GLANCE_WS_URL'] as string | undefined) ??
    `ws://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`,
);

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

    const connect = (): void => {
      setStatus((s) => (s === 'online' ? s : 'connecting'));
      const ws = new WebSocket(WS_URL);
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

    connect();
    return () => {
      closedByUs = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  return { status, stats, summary, ticker, session, settings, priorities };
}

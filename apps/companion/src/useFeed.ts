import { useEffect, useRef, useState } from 'react';
import { getToken } from './deviceToken';
import type {
  ChannelEvent,
  ChatSummary,
  DashboardStats,
  EngineSettings,
  PriorityCallout,
  ServerMessage,
  SessionState,
} from '@glance/core';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface FeedEvent {
  event: ChannelEvent;
  score: number;
}

export interface Feed {
  status: ConnectionStatus;
  priorities: PriorityCallout[];
  events: FeedEvent[];
  session: SessionState | null;
  settings: EngineSettings | null;
  stats: DashboardStats | null;
  summary: ChatSummary | null;
}

const WS_BASE =
  (import.meta.env['VITE_GLANCE_WS_URL'] as string | undefined) ??
  `ws://localhost:${(import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787'}`;
function wsUrl(): string {
  const token = getToken();
  if (!token) return WS_BASE;
  return `${WS_BASE}${WS_BASE.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Subscribes to the gateway and exposes just what the companion needs: connection
 *  status, AI priorities, channel events, session (viewer count), settings (audio
 *  routing) and stats (chatters). Auto-reconnects. */
export function useFeed(): Feed {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [priorities, setPriorities] = useState<PriorityCallout[]>([]);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [session, setSession] = useState<SessionState | null>(null);
  const [settings, setSettings] = useState<EngineSettings | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [summary, setSummary] = useState<ChatSummary | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closedByUs = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      setStatus((s) => (s === 'online' ? s : 'connecting'));
      const ws = new WebSocket(wsUrl());
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
          case 'priorities':
            setPriorities(msg.data);
            break;
          case 'event':
            setEvents((p) => [{ event: msg.data, score: msg.score }, ...p].slice(0, 8));
            break;
          case 'session':
            setSession(msg.data);
            break;
          case 'settings':
            setSettings(msg.data);
            break;
          case 'stats':
            setStats(msg.data);
            break;
          case 'summary':
            setSummary(msg.data);
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

  return { status, priorities, events, session, settings, stats, summary };
}

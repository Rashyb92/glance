import { useEffect, useRef, useState } from 'react';
import type { ChannelEvent, ChatSummary, HudItem, ScoredMessage } from '@glance/core';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export interface FeedEvent {
  event: ChannelEvent;
  score: number;
}

export interface FeedState {
  status: ConnectionStatus;
  messages: ScoredMessage[];
  events: FeedEvent[];
  summary: ChatSummary | null;
}

const WS_PORT = (import.meta.env['VITE_GLANCE_WS'] as string | undefined) ?? '8787';
const WS_URL = `ws://localhost:${WS_PORT}`;
const MAX_MESSAGES = 80;
const MAX_EVENTS = 8;

type Wire = HudItem | { type: 'hello'; data: { ts: number } };

/**
 * Subscribes to the Glance server's scored feed over WebSocket, with automatic
 * reconnect. Deliberately presentation-free: any render target (this browser HUD,
 * a Meta Web App, a Brilliant Labs companion) can consume this same hook.
 */
export function useGlanceFeed(): FeedState {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [messages, setMessages] = useState<ScoredMessage[]>([]);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [summary, setSummary] = useState<ChatSummary | null>(null);
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
        let wire: Wire;
        try {
          wire = JSON.parse(ev.data as string) as Wire;
        } catch {
          return;
        }
        switch (wire.type) {
          case 'message':
            setMessages((prev) => [...prev, wire.data].slice(-MAX_MESSAGES));
            break;
          case 'event':
            setEvents((prev) => [{ event: wire.data, score: wire.score }, ...prev].slice(0, MAX_EVENTS));
            break;
          case 'summary':
            setSummary(wire.data);
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

  return { status, messages, events, summary };
}

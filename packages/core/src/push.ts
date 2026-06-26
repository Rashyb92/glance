import type { SalienceCategory } from './types';
import type { ServerMessage } from './protocol';

/**
 * @glance/core — push notifications.
 *
 * The "wrist/phone" render target: the salience-filtered moments worth interrupting
 * a creator for, shaped into a notification. Only the highest-signal events push
 * (the top priority callout and channel events) — never the message firehose — which
 * is exactly what makes a watch tap or a phone banner useful instead of noisy. Pure
 * and unit-tested; the server dispatches the result to registered devices.
 */
export interface PushNotification {
  title: string;
  body: string;
  category: SalienceCategory | 'event';
  /** Dedup key so the same moment isn't pushed twice. */
  tag: string;
}

const EVENT_TITLE: Record<string, string> = {
  raid: 'Raid incoming',
  subscription: 'New subscriber',
  resub: 'Resub',
  gift_subs: 'Gifted subs',
  announcement: 'Announcement',
};

/** Shape a push from a server message, or null if it isn't push-worthy. */
export function pushNotificationFor(message: ServerMessage): PushNotification | null {
  if (message.type === 'priorities') {
    const p = message.data[0];
    if (!p) return null;
    return {
      title: 'Worth answering',
      body: truncate(`${p.author ?? 'chat'}: ${p.text}`, 140),
      category: p.category,
      tag: `prio:${p.id}`,
    };
  }
  if (message.type === 'event') {
    const e = message.data;
    return {
      title: EVENT_TITLE[e.kind] ?? 'Channel event',
      body: truncate(e.summary, 140),
      category: 'event',
      tag: `evt:${e.id}`,
    };
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

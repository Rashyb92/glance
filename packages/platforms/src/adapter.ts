import type { ChatMessage, ChannelEvent, Platform } from '@glance/core';

/**
 * The platform-integration seam.
 *
 * Every streaming platform (Twitch today; Kick, YouTube, TikTok later) implements
 * this one interface. The rest of Glance consumes normalized {@link ChatMessage}
 * and {@link ChannelEvent} objects and never has to know where they came from.
 * Adding a platform = adding one file that implements `PlatformAdapter`.
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  readonly channel: string;
  start(handlers: AdapterHandlers): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface AdapterHandlers {
  onMessage: (message: ChatMessage) => void;
  onEvent: (event: ChannelEvent) => void;
  onStatus?: (status: AdapterStatus) => void;
}

export type AdapterStatus =
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'reconnecting'; reason?: string }
  | { state: 'closed'; reason?: string };

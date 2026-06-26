import type { HudItem } from './types';
import type { DashboardStats } from './stats';

/**
 * The complete set of messages the server can push to any render target over the
 * gateway. Both the HUD and the Command Center parse this union.
 */
export type ServerMessage =
  | HudItem
  | { type: 'stats'; data: DashboardStats }
  | { type: 'hello'; data: { ts: number } };

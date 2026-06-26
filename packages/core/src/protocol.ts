import type { HudItem, SessionState } from './types';
import type { DashboardStats } from './stats';
import type { EngineSettings } from './settings';

/**
 * The complete set of messages the server can push to any render target over the
 * gateway. Both the HUD and the Command Center parse this union.
 */
export type ServerMessage =
  | HudItem
  | { type: 'stats'; data: DashboardStats }
  | { type: 'session'; data: SessionState }
  | { type: 'settings'; data: EngineSettings }
  | { type: 'hello'; data: { ts: number } };

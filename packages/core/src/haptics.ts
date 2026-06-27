import type { SalienceCategory } from './types';

/**
 * @glance/core — haptic patterns.
 *
 * The "feel it" arm of the routing matrix. Each salience category maps to a distinct
 * vibration rhythm (Web Vibration API format: alternating vibrate/pause durations in ms),
 * so a creator can *feel* what kind of moment arrived without looking or hearing it —
 * eyes on the game, earbuds optional. A donation double-taps, a question taps once,
 * moderation gives one long urgent buzz.
 *
 * Pure + shared so every surface (phone companion, HUD on a handset, the native shell)
 * buzzes the same language. The actual `navigator.vibrate` / native call lives in each
 * client; this module only owns the pattern vocabulary.
 */
export function hapticPattern(category: SalienceCategory): number[] {
  switch (category) {
    case 'donation':
      return [40, 60, 40]; // brisk double-tap — celebratory
    case 'event':
      return [30, 50, 30, 50, 30]; // triple ripple — something big happened
    case 'moderation':
      return [220]; // one long, urgent buzz — needs you now
    case 'question':
    case 'mention':
      return [70]; // single firm tap — someone wants you
    case 'highlight':
    case 'trend':
      return [25, 45, 25]; // gentle double — worth a glance
    case 'chatter':
    default:
      return [20]; // soft blip
  }
}

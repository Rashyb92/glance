import { describe, it, expect } from 'vitest';
import { SessionRecorder } from '../src/recorder';
import type { ChatMessage, ScoredMessage } from '../src/types';

function scored(text: string, score: number, bits?: number, author = 'viewer'): ScoredMessage {
  const message: ChatMessage = {
    id: Math.random().toString(36).slice(2),
    platform: 'demo',
    channel: 'c',
    author,
    text,
    timestamp: 0,
    bits,
  };
  return { message, score, category: 'highlight', signals: [] };
}

describe('SessionRecorder', () => {
  it('aggregates counts, donations and a timeline', () => {
    const r = new SessionRecorder('s1', 'c', 'twitch', 1000);
    r.recordMessage(scored('hello there friends', 0.6), 1000);
    r.recordMessage(scored('take my bits', 0.95, 500, 'whale'), 6000);
    r.recordEvent(
      { id: 'e', platform: 'twitch', channel: 'c', kind: 'raid', summary: 'raid 100', timestamp: 0 },
      11000,
    );
    r.observeChatters(42);

    const d = r.finalize(21000, null);
    expect(d.messages).toBe(2);
    expect(d.bits).toBe(500);
    expect(d.events).toBe(1);
    expect(d.durationSec).toBe(20);
    expect(d.peakChatters).toBe(42);
    expect(d.topMoment?.author).toBe('whale');
    expect(d.timeline.some((t) => t.kind === 'donation')).toBe(true);
    expect(d.timeline.some((t) => t.kind === 'event')).toBe(true);
  });

  it('keeps best moments deduped and ordered, ignoring low scores', () => {
    const r = new SessionRecorder('s2', 'c', null, 0);
    r.recordMessage(scored('do the challenge', 0.6), 0);
    r.recordMessage(scored('do the challenge', 0.8), 100); // same text, higher → replaces
    r.recordMessage(scored('meh', 0.2), 200); // below threshold → ignored
    const d = r.finalize(1000, null);
    expect(d.moments.length).toBe(1);
    expect(d.moments[0]?.score).toBe(0.8);
  });

  it('reports empty sessions as having no content', () => {
    const r = new SessionRecorder('s3', 'c', null, 0);
    expect(r.hasContent()).toBe(false);
  });

  it('records creator markers into the timeline and counts as content', () => {
    const r = new SessionRecorder('s4', 'c', 'twitch', 0);
    expect(r.hasContent()).toBe(false);
    r.recordMarker('creator mark', 5000);
    expect(r.hasContent()).toBe(true);
    const d = r.finalize(6000, null);
    expect(d.timeline.find((t) => t.kind === 'marker')).toMatchObject({
      kind: 'marker',
      atSec: 5,
      label: 'creator mark',
    });
  });
});

describe('SessionRecorder — privacy redaction', () => {
  it('omits raw message text from the archive when redactText is on', () => {
    const r = new SessionRecorder('s', 'c', 'twitch', 0, true);
    r.recordMessage(scored('something private', 0.9, 100, 'whale'), 0);
    const d = r.finalize(1000, null);
    expect(d.moments[0]?.text).toBe(''); // text redacted
    expect(d.moments[0]?.author).toBe('whale'); // metadata kept
    expect(d.topMoment?.text).toBe('');
    expect(d.bits).toBe(100); // counts intact
  });

  it('keeps text when redactText is off (default)', () => {
    const r = new SessionRecorder('s', 'c', 'twitch', 0);
    r.recordMessage(scored('keep me', 0.9), 0);
    expect(r.finalize(1000, null).moments[0]?.text).toBe('keep me');
  });
});

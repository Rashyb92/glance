import { describe, it, expect } from 'vitest';
import { PaceGate, PACE_PER_MIN } from '../src/pace';

describe('PaceGate', () => {
  it('never throttles in live mode', () => {
    const g = new PaceGate('live');
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (g.allow(0.1, 1000 + i)) allowed++;
    expect(allowed).toBe(1000);
  });

  it('caps ordinary messages to the per-minute budget in calm mode', () => {
    const g = new PaceGate('calm');
    const now = 100_000;
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (g.allow(0.2, now + i)) allowed++;
    expect(allowed).toBe(PACE_PER_MIN.calm); // 8
  });

  it('always lets the biggest moments through, even over budget', () => {
    const g = new PaceGate('calm');
    const now = 200_000;
    for (let i = 0; i < 50; i++) g.allow(0.2, now + i); // exhaust ordinary budget
    expect(g.allow(0.95, now + 60)).toBe(true); // high-salience bypasses
  });

  it('refills as the 60s window slides', () => {
    const g = new PaceGate('balanced');
    const cap = PACE_PER_MIN.balanced; // 20
    let now = 0;
    for (let i = 0; i < cap; i++) expect(g.allow(0.2, now++)).toBe(true);
    expect(g.allow(0.2, now++)).toBe(false); // budget spent
    now += 61_000; // jump past the window
    expect(g.allow(0.2, now)).toBe(true); // refilled
  });

  it('applies a new pace immediately via setPace', () => {
    const g = new PaceGate('live');
    expect(g.allow(0.1, 0)).toBe(true);
    g.setPace('calm');
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (g.allow(0.1, 1000 + i)) allowed++;
    expect(allowed).toBe(PACE_PER_MIN.calm);
  });
});

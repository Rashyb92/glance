import { describe, it, expect } from 'vitest';
import { evaluateSalience, type EvalScenario } from '../src/eval';
import type { ChatMessage } from '../src/types';

let seq = 0;
function msg(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m${seq++}`,
    platform: 'twitch',
    channel: 'c',
    author: 'viewer',
    text,
    timestamp: 1000,
    ...extra,
  };
}

// Realistic, adversarial scenarios that encode the product's quality bar. These run
// through the *real* salience engine, so they double as regression protection for the
// moat — change a weight and these tell you immediately if quality moved.
const scenarios: EvalScenario[] = [
  {
    name: 'donation + question + toxic, buried in noise',
    threshold: 0.5,
    cases: [
      { message: msg('LUL'), shouldSurface: false },
      { message: msg('POG'), shouldSurface: false },
      { message: msg('W'), shouldSurface: false },
      { message: msg('ggs'), shouldSurface: false },
      { message: msg('hahaha'), shouldSurface: false },
      {
        message: msg('yo when is the next stream?'),
        shouldSurface: true,
        expectCategory: 'question',
      },
      {
        message: msg('thank you so much for the stream', { bits: 500 }),
        shouldSurface: true,
        expectCategory: 'donation',
      },
      { message: msg('kys loser'), shouldSurface: true, expectCategory: 'moderation' },
    ],
  },
  {
    name: 'copypasta trend builds then surfaces',
    threshold: 0.5,
    cases: [
      { message: msg('clap clap clap lets go', { timestamp: 1000 }), shouldSurface: false },
      { message: msg('clap clap clap lets go', { timestamp: 1100 }), shouldSurface: false },
      {
        message: msg('clap clap clap lets go', { timestamp: 1200 }),
        shouldSurface: true,
        expectCategory: 'trend',
      },
      {
        message: msg('clap clap clap lets go', { timestamp: 1300 }),
        shouldSurface: true,
        expectCategory: 'trend',
      },
    ],
  },
  {
    name: 'mention surfaces, ordinary chat does not',
    threshold: 0.5,
    context: { broadcaster: 'ninja' },
    cases: [
      { message: msg('i think the new update is pretty solid so far'), shouldSurface: false },
      { message: msg('been watching for years still the best'), shouldSurface: false },
      {
        message: msg('hey ninja what mouse do you use?'),
        shouldSurface: true,
        expectCategory: 'mention',
      },
    ],
  },
];

describe.each(scenarios)('salience eval: $name', (scenario) => {
  it('surfaces what matters, ignores noise, and labels correctly', () => {
    const r = evaluateSalience(scenario);
    expect(r.precision).toBeGreaterThanOrEqual(0.9);
    expect(r.recall).toBeGreaterThanOrEqual(0.9);
    expect(r.categoryHits).toBe(r.categoryTotal);
  });
});

describe('evaluateSalience (harness math)', () => {
  it('computes precision and recall from outcomes', () => {
    const r = evaluateSalience({
      name: 'math',
      threshold: 0.5,
      cases: [
        { message: msg('thank you', { bits: 500 }), shouldSurface: true }, // surfaces → TP
        { message: msg('lol'), shouldSurface: false }, // noise, doesn't surface → TN
        { message: msg('hello there everyone'), shouldSurface: true }, // ordinary, won't surface → FN
      ],
    });
    expect(r.truePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
    expect(r.precision).toBe(1); // nothing wrong surfaced
    expect(r.recall).toBe(0.5); // caught 1 of 2 that mattered
  });
});

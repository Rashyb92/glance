/**
 * Lightweight lexicon sentiment, in the range -1 (negative) .. 1 (positive).
 * Pure and deterministic — it feeds the audience-mood read and gives the salience
 * engine a sense of emotional charge. Not a replacement for a real model; a fast,
 * explainable floor that runs on every message with zero cost.
 */
const POSITIVE = new Set([
  'love', 'great', 'amazing', 'awesome', 'best', 'good', 'nice', 'cool', 'wow', 'happy',
  'fun', 'win', 'goat', 'legend', 'pog', 'poggers', 'beautiful', 'perfect', 'thanks',
  'thank', 'congrats', 'epic', 'clean', 'insane', 'incredible', 'support', 'wholesome',
  'based', 'king', 'queen', 'w', 'goated', 'fire', 'banger',
]);

const NEGATIVE = new Set([
  'hate', 'bad', 'terrible', 'awful', 'worst', 'boring', 'lame', 'trash', 'garbage', 'sad',
  'angry', 'cringe', 'sucks', 'annoying', 'disappointed', 'quit', 'wrong', 'fail', 'broken',
  'toxic', 'scam', 'rigged', 'l', 'mid', 'ratio', 'flop', 'dead', 'unwatchable',
]);

const NEGATORS = new Set(['not', 'no', 'never', 'dont', 'didnt', 'isnt', 'wasnt', 'cant', 'wont', 'aint']);

export function analyzeSentiment(text: string): number {
  const words = text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 0;

  let score = 0;
  let hits = 0;
  let negate = false;
  for (const word of words) {
    const w = word.replace(/'/g, '');
    if (NEGATORS.has(w)) {
      negate = true;
      continue;
    }
    let value = 0;
    if (POSITIVE.has(w)) value = 1;
    else if (NEGATIVE.has(w)) value = -1;
    if (value !== 0) {
      score += negate ? -value : value;
      hits += 1;
    }
    negate = false;
  }
  if (hits === 0) return 0;
  return round2(clamp(score / 3, -1, 1));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

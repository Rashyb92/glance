import { scoreMessage, type SalienceContext } from './salience';
import { TrendTracker } from './trends';
import type { ChatMessage, SalienceCategory } from './types';

/**
 * @glance/core — salience evaluation harness.
 *
 * The moat is the salience model, so it has to be measured, not asserted. This runs a
 * scripted chat scenario through the *real* engine — driving a live {@link TrendTracker}
 * so spam waves and copypasta score realistically — and reports precision/recall on
 * "the moments that matter", plus category accuracy. It's both a tuning instrument and
 * executable regression protection for the thing the whole business depends on.
 */
export interface EvalCase {
  message: ChatMessage;
  /** Should this message break through (score >= the scenario threshold)? */
  shouldSurface: boolean;
  /** Optional expected dominant category (e.g. 'moderation' for a toxic message). */
  expectCategory?: SalienceCategory;
}

export interface EvalScenario {
  name: string;
  threshold: number;
  context?: Omit<SalienceContext, 'trendCount'>;
  cases: EvalCase[];
}

export interface EvalMiss {
  text: string;
  expectedSurface: boolean;
  score: number;
  category: SalienceCategory;
}

export interface EvalResult {
  name: string;
  precision: number; // of what surfaced, how much was worth it
  recall: number; // of what mattered, how much surfaced
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  categoryHits: number;
  categoryTotal: number;
  misses: EvalMiss[];
}

export function evaluateSalience(scenario: EvalScenario): EvalResult {
  const trends = new TrendTracker();
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let categoryHits = 0;
  let categoryTotal = 0;
  const misses: EvalMiss[] = [];

  for (const c of scenario.cases) {
    const trendCount = trends.record(c.message.text, c.message.timestamp);
    const scored = scoreMessage(c.message, { ...scenario.context, trendCount });
    const surfaced = scored.score >= scenario.threshold;

    if (surfaced && c.shouldSurface) {
      truePositives += 1;
    } else if (surfaced && !c.shouldSurface) {
      falsePositives += 1;
      misses.push({
        text: c.message.text,
        expectedSurface: false,
        score: scored.score,
        category: scored.category,
      });
    } else if (!surfaced && c.shouldSurface) {
      falseNegatives += 1;
      misses.push({
        text: c.message.text,
        expectedSurface: true,
        score: scored.score,
        category: scored.category,
      });
    }

    if (c.expectCategory) {
      categoryTotal += 1;
      if (scored.category === c.expectCategory) categoryHits += 1;
    }
  }

  const precision =
    truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 1;
  const recall =
    truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    name: scenario.name,
    precision: round3(precision),
    recall: round3(recall),
    f1: round3(f1),
    truePositives,
    falsePositives,
    falseNegatives,
    categoryHits,
    categoryTotal,
    misses,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

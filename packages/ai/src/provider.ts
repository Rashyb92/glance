import type { ChatSummary, PriorityCallout, ScoredMessage } from '@glance/core';

/**
 * The AI seam. Today: a deterministic rule-based provider and a Claude provider.
 * Tomorrow: OpenAI, a fine-tuned salience model, or an on-device model — all
 * behind this one interface, so the server never changes.
 */
export interface AIProvider {
  readonly name: string;
  /** Produce a short, calm audience summary for AI Assist / Hybrid modes. */
  summarize(input: SummarizeInput): Promise<ChatSummary>;
  /** Re-rank recent candidates into the few things the streamer should act on now. */
  prioritize(input: PrioritizeInput): Promise<PriorityCallout[]>;
}

export interface SummarizeInput {
  channel: string;
  broadcaster?: string;
  /** Recent, already-scored messages to summarize. */
  recent: ScoredMessage[];
}

export interface PrioritizeInput {
  channel: string;
  broadcaster?: string;
  /** Recent above-threshold messages to re-rank. */
  candidates: ScoredMessage[];
}

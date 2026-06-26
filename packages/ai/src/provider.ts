import type { ChatSummary, ScoredMessage } from '@glance/core';

/**
 * The AI seam. Today: a deterministic rule-based provider and a Claude provider.
 * Tomorrow: OpenAI, a fine-tuned salience model, or an on-device model — all
 * behind this one interface, so the server never changes.
 */
export interface AIProvider {
  readonly name: string;
  /** Produce a short, calm audience summary for AI Assist / Hybrid modes. */
  summarize(input: SummarizeInput): Promise<ChatSummary>;
}

export interface SummarizeInput {
  channel: string;
  broadcaster?: string;
  /** Recent, already-scored messages to summarize. */
  recent: ScoredMessage[];
}

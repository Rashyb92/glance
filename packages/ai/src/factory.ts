import type { AIProvider } from './provider';
import { AnthropicProvider } from './anthropic';
import { RulesProvider } from './rules';

export interface AIConfig {
  anthropicApiKey?: string;
  model?: string;
}

/**
 * Pick the best available provider. With a key → Claude (with a rule-based safety
 * net underneath). Without a key → the deterministic rule-based engine. Either
 * way the caller receives the same {@link AIProvider} and never branches on it.
 */
export function createAIProvider(config: AIConfig = {}): AIProvider {
  const key = (config.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '').trim();
  if (key.length > 0) {
    return new AnthropicProvider(key, config.model ?? process.env['GLANCE_AI_MODEL']);
  }
  return new RulesProvider();
}

import { anthropicProvider } from './anthropic.js';
import { openAICompatibleProvider } from './openai-compatible.js';
import { ollamaProvider } from './ollama.js';

/**
 * Provider registry. To add a new AI provider:
 *   1. Create a file in this folder exporting an object with
 *      { id, name, capabilities, getConfig(), open(params) }
 *      (copy anthropic.js as a template).
 *   2. Add it to this list.
 * Nothing else in the app needs to change — the frontend reads the list
 * from /api/status.
 */
export const PROVIDERS = [anthropicProvider, ollamaProvider, openAICompatibleProvider];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

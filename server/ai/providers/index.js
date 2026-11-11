import { anthropicProvider } from './anthropic.js';
import { openAICompatibleProvider } from './openai-compatible.js';
import { ollamaProvider } from './ollama.js';
import { groqProvider } from './groq.js';

/**
 * Provider registry. To add a new AI provider:
 *   1. Create a file in this folder exporting an object with
 *      { id, name, capabilities, getConfig(), open(params) }
 *      (copy anthropic.js as a template).
 *   2. Add it to this list.
 * Nothing else in the app needs to change — the frontend reads the list
 * from /api/status.
 */
// Order = priority when AI_PROVIDER is "auto". Groq and Ollama come before
// Anthropic because Netlify's AI Gateway auto-injects an Anthropic key on
// every site, which would otherwise take over (and spend Netlify credits)
// without you asking.
export const PROVIDERS = [groqProvider, ollamaProvider, anthropicProvider, openAICompatibleProvider];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

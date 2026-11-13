import { geminiProvider } from './gemini.js';
import { mistralProvider } from './mistral.js';
import { openRouterProvider } from './openrouter.js';
import { groqProvider } from './groq.js';
import { ollamaProvider } from './ollama.js';
import { anthropicProvider } from './anthropic.js';
import { openAICompatibleProvider } from './openai-compatible.js';

/**
 * Provider registry. To add a new AI provider:
 *   1. Create a file in this folder exporting an object with
 *      { id, name, shortName, capabilities, getConfig(), open(params) }
 *      (copy groq.js as a template). getConfig() returns
 *      { configured, models, defaultModel, visionModels, maxImages }.
 *   2. Add it to this list.
 * The frontend reads the list from /api/status.
 *
 * Order = base priority: Google Gemini → Vibe AI (Mistral AI) → OpenRouter →
 * Groq → Ollama. It is the default when AI_PROVIDER is "auto"; Automatic mode
 * re-orders these per message (see AUTO_PREFERENCES in ../router.js).
 * Anthropic and the generic OpenAI-compatible slot come last on purpose:
 * Netlify's AI Gateway auto-injects an Anthropic key on every site, which
 * would otherwise take over (and spend Netlify credits) without you asking.
 */
export const PROVIDERS = [geminiProvider, mistralProvider, openRouterProvider, groqProvider, ollamaProvider, anthropicProvider, openAICompatibleProvider];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

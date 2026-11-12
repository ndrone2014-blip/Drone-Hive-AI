import { getEnv, getEnvList } from '../../env.js';
import { AIError, ERROR_CODES } from '../errors.js';
import { openChatCompletions } from './openai-compatible.js';

/**
 * Groq provider (GroqCloud).
 *
 *  - Create a free API key at https://console.groq.com/keys (no card needed
 *    for the free plan). Keys start with "gsk_".
 *  - Set GROQ_API_KEY on the server (Netlify env var or .env). That's it.
 *
 * Uses Groq's OpenAI-compatible endpoint: https://api.groq.com/openai/v1
 * Change the model list any time with GROQ_MODEL / GROQ_MODELS using the
 * exact model IDs from https://console.groq.com/docs/models
 * (Groq retires models from time to time — if replies fail with
 * "could not find that model", update these.)
 */
const BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
// Vision (image input) models: https://console.groq.com/docs/vision — override with GROQ_VISION_MODELS.
const DEFAULT_VISION_MODELS = ['qwen/qwen3.8-27b'];

export const groqProvider = {
  id: 'groq',
  name: 'Groq',
  shortName: 'Groq',
  capabilities: { streaming: true, vision: true, documents: false, tools: false },

  getConfig() {
    const apiKey = getEnv('GROQ_API_KEY');
    const listed = getEnvList('GROQ_MODELS') || DEFAULT_MODELS;
    const defaultModel = getEnv('GROQ_MODEL', listed[0]);
    return {
      configured: Boolean(apiKey),
      apiKey,
      baseUrl: BASE_URL,
      models: [...new Set([defaultModel, ...listed])],
      defaultModel,
      visionModels: getEnvList('GROQ_VISION_MODELS') || DEFAULT_VISION_MODELS,
      maxImages: 3, // Groq's per-request image limit
    };
  },

  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'Groq API key is not set (GROQ_API_KEY).', 503);
    // Qwen models on Groq can include their private "thinking" text; hide it.
    const extraBody = /^qwen\//i.test(model) ? { reasoning_format: 'hidden' } : undefined;
    return openChatCompletions({ ...cfg, providerName: this.name, model, system, messages, maxTokens, temperature, signal, extraBody, includeUsage: true });
  },
};

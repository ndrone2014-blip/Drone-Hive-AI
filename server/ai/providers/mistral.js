import { getEnv, getEnvList } from '../../env.js';
import { AIError, ERROR_CODES } from '../errors.js';
import { openChatCompletions } from './openai-compatible.js';
import { readProviderKey } from './keys.js';

/**
 * Vibe AI (Mistral AI) provider.
 *
 * "Vibe AI" and "Mistral AI" are the SAME provider in Drone Hive AI: one
 * integration, one key, one entry in every menu.
 *
 *  - Create a key at https://console.mistral.ai/api-keys (the free
 *    "Experiment" plan needs no card).
 *  - Set MISTRAL_API_KEY on the server (Netlify env var or .env). That's it.
 *
 * Uses Mistral's chat completions endpoint (OpenAI-style format, streaming):
 * https://api.mistral.ai/v1/chat/completions
 * Change models with MISTRAL_MODEL / MISTRAL_MODELS using IDs from
 * https://docs.mistral.ai/getting-started/models
 */
const BASE_URL = 'https://api.mistral.ai/v1';
// Strong all-rounder, fast small model, and Mistral's coding model.
const DEFAULT_MODELS = ['mistral-medium-latest', 'mistral-small-latest', 'codestral-latest'];
// Mistral Medium and Small both read images (https://docs.mistral.ai/capabilities/vision).
const DEFAULT_VISION_MODELS = ['mistral-medium-latest', 'mistral-small-latest'];

/** Mistral's documented image format: image_url is the data URL itself. */
function toMistralMessage(m) {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ...m.images.map((img) => ({ type: 'image_url', image_url: `data:${img.mediaType};base64,${img.data}` })),
    ],
  };
}

export const mistralProvider = {
  id: 'mistral',
  name: 'Vibe AI (Mistral AI)',
  shortName: 'Vibe AI',
  capabilities: { streaming: true, vision: true, documents: false, tools: false },

  getConfig() {
    const found = readProviderKey(['MISTRAL_API_KEY'], { baseUrlVar: 'MISTRAL_BASE_URL', officialHost: /^https:\/\/api\.mistral\.ai(\/|$)/i });
    const apiKey = found.apiKey;
    const listed = getEnvList('MISTRAL_MODELS') || DEFAULT_MODELS;
    const defaultModel = getEnv('MISTRAL_MODEL', listed[0]);
    const models = [...new Set([defaultModel, ...listed])];
    const vision = getEnvList('MISTRAL_VISION_MODELS') || DEFAULT_VISION_MODELS;
    return {
      configured: Boolean(apiKey),
      issue: found.issue,
      apiKey,
      baseUrl: BASE_URL,
      models,
      defaultModel,
      visionModels: vision,
      maxImages: 4,
    };
  },

  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'Vibe AI (Mistral AI) API key is not set (MISTRAL_API_KEY).', 503);
    // Mistral includes token usage in the last streamed chunk on its own, so no
    // stream_options are sent (unknown fields can be rejected with 422).
    return openChatCompletions({ ...cfg, providerName: this.name, model, system, messages, maxTokens, temperature, signal, mapMessage: toMistralMessage });
  },
};

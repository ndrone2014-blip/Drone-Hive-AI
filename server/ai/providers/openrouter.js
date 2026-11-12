import { getEnv, getEnvList } from '../../env.js';
import { AIError, ERROR_CODES } from '../errors.js';
import { openChatCompletions } from './openai-compatible.js';

/**
 * OpenRouter provider — one key, hundreds of models (many of them free).
 *
 *  - Create a key at https://openrouter.ai/keys (keys start with "sk-or-").
 *  - Set OPENROUTER_API_KEY on the server (Netlify env var or .env).
 *
 * FREE-ONLY BY DEFAULT: only models ending in ":free" (plus the
 * "openrouter/free" router) are allowed, so the site can never spend
 * OpenRouter credits by accident. To allow paid models on purpose, set
 * OPENROUTER_ALLOW_PAID=true.
 *
 * Free models rotate often. "openrouter/free" automatically picks a free
 * model that is currently online, so it is the default. Change the list with
 * OPENROUTER_MODEL / OPENROUTER_MODELS (IDs from openrouter.ai/models).
 */
const BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODELS = ['openrouter/free', 'openai/gpt-oss-120b:free'];
// The free router accepts images and picks a free model that can see them.
const DEFAULT_VISION_MODELS = ['openrouter/free'];

export function isFreeOpenRouterModel(id) {
  return id === 'openrouter/free' || /:free$/.test(id);
}

export const openRouterProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  shortName: 'OpenRouter',
  capabilities: { streaming: true, vision: true, documents: false, tools: false },

  getConfig() {
    const apiKey = getEnv('OPENROUTER_API_KEY');
    const allowPaid = getEnv('OPENROUTER_ALLOW_PAID', 'false') === 'true';
    let listed = getEnvList('OPENROUTER_MODELS') || DEFAULT_MODELS;
    let defaultModel = getEnv('OPENROUTER_MODEL', listed[0]);
    let models = [...new Set([defaultModel, ...listed])];
    if (!allowPaid) {
      models = models.filter(isFreeOpenRouterModel);
      if (!models.length) models = [...DEFAULT_MODELS];
      if (!models.includes(defaultModel)) defaultModel = models[0];
    }
    let visionModels = getEnvList('OPENROUTER_VISION_MODELS') || DEFAULT_VISION_MODELS;
    if (!allowPaid) visionModels = visionModels.filter(isFreeOpenRouterModel);
    return { configured: Boolean(apiKey), apiKey, baseUrl: BASE_URL, models, defaultModel, allowPaid, visionModels, maxImages: 4 };
  },

  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'OpenRouter API key is not set (OPENROUTER_API_KEY).', 503);
    // Belt and braces: never send a paid model unless explicitly allowed.
    if (!cfg.allowPaid && !isFreeOpenRouterModel(model)) model = cfg.defaultModel;
    if (!cfg.allowPaid && !isFreeOpenRouterModel(model)) throw new AIError(ERROR_CODES.MODEL_NOT_FOUND, 'OpenRouter has no free model configured.', 502);
    return openChatCompletions({
      ...cfg,
      providerName: this.name,
      model,
      system,
      messages,
      maxTokens,
      temperature,
      signal,
      includeUsage: true,
      // Optional attribution headers OpenRouter shows on its dashboard.
      extraHeaders: { 'x-title': 'Drone Hive AI', 'http-referer': getEnv('URL', 'https://dronehiveai.netlify.app') },
    });
  },
};

import { getEnv, getEnvList } from '../../env.js';
import { AIError, ERROR_CODES } from '../errors.js';
import { openChatCompletions, isGeminiCompatUrl } from './openai-compatible.js';

/**
 * Google Gemini provider (Gemini API, free tier available).
 *
 *  - Get a key at https://aistudio.google.com/apikey and set GEMINI_API_KEY.
 *  - ALSO works with no new variables if Gemini was already set up through the
 *    OpenAI-compatible slot (OPENAI_COMPAT_BASE_URL pointing at
 *    generativelanguage.googleapis.com) — it reuses that key and model list.
 *
 * Uses Gemini's OpenAI-compatible endpoint, which supports streaming and
 * image input (base64 data URLs). Gemini models are natively multimodal.
 * Change models with GEMINI_MODEL / GEMINI_MODELS (IDs from ai.google.dev/gemini-api/docs/models).
 */
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

export const geminiProvider = {
  id: 'gemini',
  name: 'Google Gemini',
  shortName: 'Gemini',
  capabilities: { streaming: true, vision: true, documents: false, tools: false },

  getConfig() {
    const compatIsGemini = isGeminiCompatUrl(getEnv('OPENAI_COMPAT_BASE_URL'));
    const apiKey = getEnv('GEMINI_API_KEY') || (compatIsGemini ? getEnv('OPENAI_COMPAT_API_KEY') : undefined);
    const listed = getEnvList('GEMINI_MODELS') || (compatIsGemini && getEnvList('OPENAI_COMPAT_MODELS')) || DEFAULT_MODELS;
    const defaultModel = getEnv('GEMINI_MODEL') || (compatIsGemini && getEnv('OPENAI_COMPAT_MODEL')) || listed[0];
    const models = [...new Set([defaultModel, ...listed])];
    const vision = getEnvList('GEMINI_VISION_MODELS');
    return {
      configured: Boolean(apiKey),
      apiKey,
      baseUrl: BASE_URL,
      models,
      defaultModel,
      // Every current Gemini chat model accepts images.
      visionModels: vision ? vision.filter((m) => models.includes(m)) : models,
      maxImages: 4,
    };
  },

  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'Gemini API key is not set (GEMINI_API_KEY).', 503);
    // Gemini "thinking" models count thinking toward the reply limit. Keep it
    // light so short limits still leave room for the actual answer.
    const effort = getEnv('GEMINI_REASONING_EFFORT', /lite/i.test(model) ? '' : 'low');
    return openChatCompletions({
      ...cfg,
      providerName: this.name,
      model,
      system,
      messages,
      maxTokens,
      temperature,
      signal,
      // Set GEMINI_REASONING_EFFORT=off to send nothing.
      extraBody: effort && effort !== 'off' ? { reasoning_effort: effort } : undefined,
    });
  },
};

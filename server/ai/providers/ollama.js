import { getEnv, getEnvList } from '../../env.js';
import { AIError, ERROR_CODES } from '../errors.js';
import { openChatCompletions } from './openai-compatible.js';

/**
 * Ollama provider.
 *
 *  - Ollama Cloud (default): set OLLAMA_API_KEY (create one at ollama.com → Settings → Keys).
 *  - Local Ollama (your PC only): set OLLAMA_BASE_URL=http://localhost:11434/v1 — no key needed.
 *
 * Uses Ollama's OpenAI-compatible /v1/chat/completions endpoint.
 * Change the model list any time with OLLAMA_MODEL / OLLAMA_MODELS
 * (use the exact model names shown on ollama.com).
 */
const CLOUD_URL = 'https://ollama.com/v1';
const DEFAULT_MODELS = ['gpt-oss:120b', 'gpt-oss:20b'];

export const ollamaProvider = {
  id: 'ollama',
  name: 'Ollama',
  capabilities: { streaming: true, vision: false, documents: false, tools: false },

  getConfig() {
    const apiKey = getEnv('OLLAMA_API_KEY');
    const baseUrl = getEnv('OLLAMA_BASE_URL', CLOUD_URL).replace(/\/+$/, '');
    const isCloud = baseUrl === CLOUD_URL;
    const listed = getEnvList('OLLAMA_MODELS') || DEFAULT_MODELS;
    const defaultModel = getEnv('OLLAMA_MODEL', listed[0]);
    return {
      // Cloud needs a key; a custom (local) URL works without one.
      configured: isCloud ? Boolean(apiKey) : Boolean(getEnv('OLLAMA_BASE_URL')),
      apiKey,
      baseUrl,
      models: [...new Set([defaultModel, ...listed])],
      defaultModel,
    };
  },

  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'Ollama API key is not set (OLLAMA_API_KEY).', 503);
    return openChatCompletions({ ...cfg, providerName: this.name, model, system, messages, maxTokens, temperature, signal });
  },
};

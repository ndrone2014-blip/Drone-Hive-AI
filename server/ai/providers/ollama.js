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
// Image-capable model on Ollama Cloud. Override with OLLAMA_VISION_MODELS.
const DEFAULT_CLOUD_VISION_MODELS = ['qwen3-vl:235b'];

export const ollamaProvider = {
  id: 'ollama',
  name: 'Ollama',
  shortName: 'Ollama',
  capabilities: { streaming: true, vision: true, documents: false, tools: false },

  getConfig() {
    const apiKey = getEnv('OLLAMA_API_KEY');
    const baseUrl = getEnv('OLLAMA_BASE_URL', CLOUD_URL).replace(/\/+$/, '');
    const isCloud = baseUrl === CLOUD_URL;
    const listed = getEnvList('OLLAMA_MODELS') || DEFAULT_MODELS;
    const defaultModel = getEnv('OLLAMA_MODEL', listed[0]);
    // Safety: on the public Netlify site, never talk to an Ollama on a private
    // network or this computer (localhost, 192.168.x.x, …). That only works
    // with `npm start` on your own PC, which listens on 127.0.0.1 only.
    const blockedLocal = !isCloud && isPublicDeployment() && isPrivateAddress(baseUrl);
    const validUrl = /^https?:\/\//i.test(baseUrl);
    return {
      // Cloud needs a key; a custom (local) URL works without one.
      configured: validUrl && !blockedLocal && (isCloud ? Boolean(apiKey) : Boolean(getEnv('OLLAMA_BASE_URL'))),
      apiKey,
      baseUrl,
      models: [...new Set([defaultModel, ...listed])],
      defaultModel,
      visionModels: getEnvList('OLLAMA_VISION_MODELS') || (isCloud ? DEFAULT_CLOUD_VISION_MODELS : []),
      maxImages: 3,
      isLocal: !isCloud,
    };
  },

  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'Ollama API key is not set (OLLAMA_API_KEY).', 503);
    return openChatCompletions({ ...cfg, providerName: this.name, model, system, messages, maxTokens, temperature, signal });
  },
};

/** True when running on Netlify (the public site) rather than `npm start`. */
function isPublicDeployment() {
  return Boolean(globalThis.Netlify) || Boolean(getEnv('NETLIFY')) || getEnv('CONTEXT') === 'production';
}

/** localhost, loopback, link-local and private-network addresses. */
export function isPrivateAddress(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

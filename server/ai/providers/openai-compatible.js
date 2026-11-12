import { getEnv, getEnvList } from '../../env.js';
import { errorFromProviderResponse, streamError, AIError, ERROR_CODES } from '../errors.js';
import { parseSSE } from '../sse.js';

/** True when a URL is Google's Gemini OpenAI-compatible endpoint. */
export function isGeminiCompatUrl(url) {
  return /^https:\/\/generativelanguage\.googleapis\.com\//i.test(String(url || ''));
}

/**
 * Generic "OpenAI-compatible" provider (the /chat/completions format).
 * Many services speak this format, including some with free tiers and local
 * runners such as Ollama or LM Studio. Activate by setting:
 *   OPENAI_COMPAT_BASE_URL  e.g. https://example.com/v1
 *   OPENAI_COMPAT_API_KEY   (can be any text for local runners)
 *   OPENAI_COMPAT_MODEL     the model ID that service uses
 */
export const openAICompatibleProvider = {
  id: 'openai-compatible',
  get name() {
    return getEnv('OPENAI_COMPAT_NAME', 'OpenAI-compatible');
  },
  get shortName() {
    return this.name;
  },
  capabilities: { streaming: true, vision: false, documents: false, tools: false },

  getConfig() {
    const apiKey = getEnv('OPENAI_COMPAT_API_KEY');
    const baseUrl = (getEnv('OPENAI_COMPAT_BASE_URL', '') || '').replace(/\/+$/, '');
    const listed = getEnvList('OPENAI_COMPAT_MODELS') || [];
    const defaultModel = getEnv('OPENAI_COMPAT_MODEL', listed[0] || '');
    const models = [...new Set([defaultModel, ...listed].filter(Boolean))];
    return {
      // If this slot points at Google's Gemini endpoint, the dedicated Gemini
      // provider uses these values instead, so it isn't listed twice.
      configured: Boolean(apiKey && baseUrl && defaultModel) && !isGeminiCompatUrl(baseUrl),
      apiKey,
      baseUrl,
      models,
      defaultModel,
      visionModels: (getEnvList('OPENAI_COMPAT_VISION_MODELS') || []).filter((m) => models.includes(m)),
    };
  },

  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) {
      throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'OpenAI-compatible provider needs OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY and OPENAI_COMPAT_MODEL.', 503);
    }
    return openChatCompletions({ ...cfg, providerName: this.name, model, system, messages, maxTokens, temperature, signal });
  },
};

/**
 * Shared helper: sends a streaming /chat/completions request and returns the
 * normalized event iterator. Used by every OpenAI-format provider
 * (Gemini, Groq, OpenRouter, Ollama, custom).
 */
export async function openChatCompletions({ baseUrl, apiKey, providerName, model, system, messages, maxTokens, temperature, signal, extraHeaders, extraBody, includeUsage = false }) {
  const body = {
    ...(extraBody || {}),
    model,
    messages: [{ role: 'system', content: system }, ...messages.map(toOpenAIMessage)],
    max_tokens: maxTokens,
    stream: true,
  };
  if (includeUsage) body.stream_options = { include_usage: true };
  if (typeof temperature === 'number') body.temperature = temperature;

  const headers = { ...(extraHeaders || {}), 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw await errorFromProviderResponse(res, providerName);
  return streamEvents(res.body, providerName);
}

/** Text-only messages stay plain strings; messages with images become content parts. */
export function toOpenAIMessage(m) {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
    ],
  };
}

async function* streamEvents(body, providerName) {
  let stopReason = null;
  let usage = {};
  for await (const { data } of parseSSE(body)) {
    if (data === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error) throw streamError(providerName, json.error.message || JSON.stringify(json.error));
    const choice = json.choices?.[0];
    const text = choice?.delta?.content;
    if (text) yield { type: 'delta', text };
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    if (json.usage) usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
  }
  yield { type: 'done', stopReason, usage };
}

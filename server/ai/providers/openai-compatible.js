import { getEnv, getEnvList } from '../../env.js';
import { errorFromProviderResponse, AIError, ERROR_CODES } from '../errors.js';
import { parseSSE } from '../sse.js';

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
  capabilities: { streaming: true, vision: false, documents: false, tools: false },

  getConfig() {
    const apiKey = getEnv('OPENAI_COMPAT_API_KEY');
    const baseUrl = (getEnv('OPENAI_COMPAT_BASE_URL', '') || '').replace(/\/+$/, '');
    const listed = getEnvList('OPENAI_COMPAT_MODELS') || [];
    const defaultModel = getEnv('OPENAI_COMPAT_MODEL', listed[0] || '');
    const models = [...new Set([defaultModel, ...listed].filter(Boolean))];
    return {
      configured: Boolean(apiKey && baseUrl && defaultModel),
      apiKey,
      baseUrl,
      models,
      defaultModel,
    };
  },

  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) {
      throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'OpenAI-compatible provider needs OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY and OPENAI_COMPAT_MODEL.', 503);
    }
    const body = {
      model,
      messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      max_tokens: maxTokens,
      stream: true,
    };
    if (typeof temperature === 'number') body.temperature = temperature;

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw await errorFromProviderResponse(res, this.name);
    return streamEvents(res.body, this.name);
  },
};

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
    if (json.error) {
      throw new AIError(ERROR_CODES.PROVIDER_ERROR, `${providerName} error: ${json.error.message || 'stream error'}`, 502);
    }
    const choice = json.choices?.[0];
    const text = choice?.delta?.content;
    if (text) yield { type: 'delta', text };
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    if (json.usage) usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
  }
  yield { type: 'done', stopReason, usage };
}

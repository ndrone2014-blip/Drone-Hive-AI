import { getEnv, getEnvList } from '../../env.js';
import { errorFromProviderResponse, AIError, ERROR_CODES } from '../errors.js';
import { parseSSE } from '../sse.js';

/**
 * Anthropic Claude provider (Messages API, streaming).
 * Activate by setting ANTHROPIC_API_KEY. Uses plain fetch — no SDK dependency.
 *
 * Model IDs can be changed without touching code via ANTHROPIC_MODEL /
 * ANTHROPIC_MODELS environment variables.
 */
const DEFAULT_MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'];

export const anthropicProvider = {
  id: 'anthropic',
  name: 'Anthropic Claude',
  // What this integration currently passes through. Flip these on as the
  // features are built (images/PDFs are supported by the Claude API itself).
  capabilities: { streaming: true, vision: false, documents: false, tools: false },

  getConfig() {
    const apiKey = getEnv('ANTHROPIC_API_KEY');
    const listed = getEnvList('ANTHROPIC_MODELS') || DEFAULT_MODELS;
    const defaultModel = getEnv('ANTHROPIC_MODEL', listed[0]);

    // Netlify's AI Gateway auto-injects ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL into
    // every site and bills usage to your Netlify credits. It is BLOCKED unless you
    // opt in with ALLOW_NETLIFY_AI_GATEWAY=true. On Netlify (gateway vars present)
    // requests always go straight to Anthropic, never through the gateway.
    const onNetlifyGateway = Boolean(getEnv('NETLIFY_AI_GATEWAY_KEY') || getEnv('NETLIFY_AI_GATEWAY_BASE_URL'));
    const allowGateway = getEnv('ALLOW_NETLIFY_AI_GATEWAY', 'false') === 'true';
    const envBaseUrl = getEnv('ANTHROPIC_BASE_URL');
    const isGatewayKey =
      onNetlifyGateway &&
      Boolean(apiKey) &&
      (apiKey === getEnv('NETLIFY_AI_GATEWAY_KEY') || (envBaseUrl && !envBaseUrl.includes('api.anthropic.com')));
    const blocked = isGatewayKey && !allowGateway;
    const baseUrl = onNetlifyGateway && !allowGateway ? 'https://api.anthropic.com' : envBaseUrl || 'https://api.anthropic.com';

    return {
      configured: Boolean(apiKey) && !blocked,
      apiKey: blocked ? undefined : apiKey,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      models: [...new Set([defaultModel, ...listed])],
      defaultModel,
    };
  },

  /**
   * Opens a streaming request. Throws AIError if the provider rejects it,
   * otherwise returns an async iterator of normalized events.
   */
  async open({ model, system, messages, maxTokens, temperature, signal }) {
    const cfg = this.getConfig();
    if (!cfg.configured) throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'Anthropic API key is not set.', 503);

    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };
    if (typeof temperature === 'number') body.temperature = temperature;

    const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw await errorFromProviderResponse(res, this.name);
    return streamEvents(res.body, this.name);
  },
};

async function* streamEvents(body, providerName) {
  let stopReason = null;
  const usage = {};
  for await (const { event, data } of parseSSE(body)) {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const type = json.type || event;
    if (type === 'content_block_delta' && json.delta?.type === 'text_delta') {
      if (json.delta.text) yield { type: 'delta', text: json.delta.text };
    } else if (type === 'message_start') {
      if (json.message?.usage?.input_tokens != null) usage.inputTokens = json.message.usage.input_tokens;
    } else if (type === 'message_delta') {
      if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
      if (json.usage?.output_tokens != null) usage.outputTokens = json.usage.output_tokens;
    } else if (type === 'error') {
      throw new AIError(ERROR_CODES.PROVIDER_ERROR, `${providerName} error: ${json.error?.message || 'stream error'}`, 502);
    }
  }
  yield { type: 'done', stopReason, usage };
}

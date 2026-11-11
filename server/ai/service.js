import { APP, getServerConfig } from '../config.js';
import { PROVIDERS, getProvider } from './providers/index.js';
import { normalizeMessages } from './messages.js';
import { AIError, ERROR_CODES } from './errors.js';

/**
 * The AI service: the only place that knows how a chat request turns into a
 * provider call. HTTP handlers and the frontend never talk to providers directly.
 */

/** Picks the active provider: AI_PROVIDER if set and configured, else the first configured one. */
function resolveActiveProvider(preferred) {
  const configured = PROVIDERS.filter((p) => p.getConfig().configured);
  if (!configured.length) return null;
  if (preferred && preferred !== 'auto') {
    const p = configured.find((x) => x.id === preferred);
    if (p) return p;
  }
  return configured[0];
}

/** Public status. Never includes API keys. */
export function getStatus() {
  const cfg = getServerConfig();
  const active = resolveActiveProvider(cfg.preferredProvider);
  return {
    app: APP,
    connected: Boolean(active),
    activeProvider: active?.id || null,
    providers: PROVIDERS.map((p) => {
      const c = p.getConfig();
      return {
        id: p.id,
        name: p.name,
        configured: c.configured,
        models: c.models,
        defaultModel: c.defaultModel || null,
        capabilities: p.capabilities,
      };
    }),
    accessCodeRequired: Boolean(cfg.accessCode),
    limits: {
      maxOutputTokens: cfg.maxOutputTokens,
      maxMessageChars: cfg.limits.maxMessageChars,
      maxCustomInstructionChars: cfg.limits.maxCustomInstructionChars,
    },
    customInstructionsAllowed: cfg.allowCustomInstructions,
  };
}

/**
 * Validates a chat request and opens a stream with the chosen provider.
 * Returns { provider, model, events } where events is an async iterator of
 * { type: 'delta', text } and finally { type: 'done', stopReason, usage }.
 */
export async function openChat(body, { signal } = {}) {
  const cfg = getServerConfig();
  if (!body || typeof body !== 'object') {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Invalid request body.', 400);
  }

  // 1. Provider
  let provider = null;
  if (body.provider && body.provider !== 'auto') {
    provider = getProvider(body.provider);
    if (!provider) throw new AIError(ERROR_CODES.INVALID_REQUEST, `Unknown provider "${body.provider}".`, 400);
    if (!provider.getConfig().configured) provider = null; // fall back to any configured provider
  }
  provider = provider || resolveActiveProvider(cfg.preferredProvider);
  if (!provider) {
    throw new AIError(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      'No AI provider is connected yet. Add an API key to the server environment to enable replies.',
      503,
    );
  }
  const pcfg = provider.getConfig();

  // 2. Model (must be one this server allows, so nobody can request arbitrary models)
  const model = pcfg.models.includes(body.model) ? body.model : pcfg.defaultModel;

  // 3. Messages
  const messages = normalizeMessages(body.messages, cfg.limits);

  // 4. Options
  const opts = body.options || {};
  const maxTokens = clampInt(opts.maxTokens, 64, cfg.maxOutputTokens, cfg.maxOutputTokens);
  const temperature = typeof opts.temperature === 'number' && Number.isFinite(opts.temperature)
    ? Math.min(1, Math.max(0, opts.temperature))
    : undefined;

  // 5. System prompt = base personality + optional user custom instructions.
  //    FUTURE: long-term memory and personalities get injected here.
  let system = cfg.systemPrompt;
  if (cfg.allowCustomInstructions && typeof opts.customInstructions === 'string' && opts.customInstructions.trim()) {
    const ci = opts.customInstructions.trim().slice(0, cfg.limits.maxCustomInstructionChars);
    system += `\n\nThe user has provided these custom instructions:\n${ci}`;
  }

  const events = await provider.open({ model, system, messages, maxTokens, temperature, signal });
  return { provider: { id: provider.id, name: provider.name }, model, events };
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

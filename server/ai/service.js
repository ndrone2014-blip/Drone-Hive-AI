import { APP, getServerConfig } from '../config.js';
import { PROVIDERS, getProvider } from './providers/index.js';
import { normalizeMessages } from './messages.js';
import { AIError, ERROR_CODES } from './errors.js';
import { estimateTokens } from '../security.js';

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
      maxInputTokens: cfg.maxInputTokens,
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
export async function openChat(body, { signal, budget = Infinity } = {}) {
  const cfg = getServerConfig();
  if (!body || typeof body !== 'object') {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Invalid request body.', 400);
  }

  // 1. Provider
  let provider = null;
  if (body.provider && body.provider !== 'auto') {
    provider = getProvider(body.provider);
    if (!provider) throw new AIError(ERROR_CODES.INVALID_REQUEST, `Unknown provider "${String(body.provider).slice(0, 40)}".`, 400);
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
  const allMessages = normalizeMessages(body.messages, cfg.limits);

  // 4. Options
  const opts = body.options && typeof body.options === 'object' ? body.options : {};
  // Output cap: never above the server limit, and never above what's left of
  // this visitor's daily token allowance.
  const outputCeiling = Math.max(64, Math.min(cfg.maxOutputTokens, Number.isFinite(budget) ? budget : cfg.maxOutputTokens));
  const maxTokens = clampInt(opts.maxTokens, 64, outputCeiling, outputCeiling);
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

  // 6. Input token cap: drop the oldest messages until the request fits.
  const messages = fitToInputBudget(allMessages, system, cfg.maxInputTokens);
  const inputTokensEstimate = estimateTokens(system) + messages.reduce((n, m) => n + estimateTokens(m.content), 0);

  // 7. Hard time limit per reply, so a stuck or endless stream can't run forever.
  const timeout = AbortSignal.timeout(cfg.maxReplySeconds * 1000);
  const combined = signal ? anySignal([signal, timeout]) : timeout;

  // If the chosen model is overloaded or rate limited, automatically try the
  // other models this server allows (e.g. Gemini Flash → Flash-Lite).
  const candidates = [model, ...pcfg.models.filter((m) => m !== model)];
  let lastError;
  for (const m of candidates) {
    try {
      const events = await provider.open({ model: m, system, messages, maxTokens, temperature, signal: combined });
      return { provider: { id: provider.id, name: provider.name }, model: m, events, maxTokens, inputTokensEstimate };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AIError && (err.code === ERROR_CODES.PROVIDER_UNAVAILABLE || err.code === ERROR_CODES.RATE_LIMITED);
      if (!retryable || combined.aborted) throw err;
    }
  }
  throw lastError;
}

function fitToInputBudget(messages, system, maxInputTokens) {
  const budget = maxInputTokens - estimateTokens(system);
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = estimateTokens(messages[i].content);
    if (used + cost > budget) break;
    out.unshift(messages[i]);
    used += cost;
  }
  if (!out.length) {
    throw new AIError(
      ERROR_CODES.INPUT_TOO_LARGE,
      `Your message is too long (limit is about ${Math.max(0, budget * 4).toLocaleString()} characters). Shorten it and try again.`,
      413,
    );
  }
  // History must still start with a user message.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

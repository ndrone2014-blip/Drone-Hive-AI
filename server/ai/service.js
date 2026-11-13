import { APP, getServerConfig } from '../config.js';
import { PROVIDERS } from './providers/index.js';
import { normalizeMessages, countImages, IMAGE_TOKEN_ESTIMATE } from './messages.js';
import { AIError, ERROR_CODES } from './errors.js';
import { estimateTokens } from '../security.js';
import { AUTO_ORDER, planRoute, resolveDefaultProvider, runRoute } from './router.js';
import { IDENTITY_PROMPT, asksAboutUnderlyingModel, guardIdentity } from '../identity.js';
import { buildMemoryPrompt, extractMemoryCommands } from '../memory/prompt.js';
import { memoryStoreMode } from '../memory/store.js';
import { MEMORY_LIMITS } from '../../public/js/shared/memory-rules.js';

/**
 * The AI service: the only place that knows how a chat request turns into a
 * provider call. HTTP handlers and the frontend never talk to providers directly.
 *
 *   prepareChat(body)  validates everything and plans which providers to try
 *                      (no network calls — errors here become HTTP errors)
 *   startChat(prep)    runs the plan: tries providers until one answers
 */

/** Public status. Never includes API keys, error details or internal settings. */
export function getStatus() {
  const cfg = getServerConfig();
  const active = resolveDefaultProvider(cfg.preferredProvider);
  const providers = PROVIDERS.map((p) => {
    const c = p.getConfig();
    return {
      id: p.id,
      name: p.name,
      shortName: p.shortName || p.name,
      configured: c.configured,
      // Why a provider isn't connected (e.g. 'gateway-placeholder'). Never a key.
      ...(c.configured || !c.issue ? {} : { issue: c.issue }),
      models: c.models,
      defaultModel: c.defaultModel || null,
      capabilities: { ...p.capabilities, vision: Boolean(c.configured && c.visionModels?.length) },
    };
  });
  return {
    app: APP,
    connected: Boolean(active),
    activeProvider: active?.id || null,
    providers,
    modes: ['automatic', 'default'],
    defaultMode: 'automatic',
    automaticOrder: AUTO_ORDER,
    vision: providers.some((p) => p.capabilities.vision),
    accessCodeRequired: Boolean(cfg.accessCode),
    limits: {
      maxOutputTokens: cfg.maxOutputTokens,
      responseLengths: cfg.responseLengths,
      maxInputTokens: cfg.maxInputTokens,
      maxMessageChars: cfg.limits.maxMessageChars,
      maxCustomInstructionChars: cfg.limits.maxCustomInstructionChars,
      maxImages: cfg.limits.maxImages,
      maxImageBytes: cfg.limits.maxImageBytes,
    },
    customInstructionsAllowed: cfg.allowCustomInstructions,
    memory: { store: memoryStoreMode(), maxItems: MEMORY_LIMITS.maxItems, maxChars: MEMORY_LIMITS.maxChars },
  };
}

/**
 * Validates a chat request and plans the route. No provider is contacted yet.
 * `budget` = tokens this user may still use today (from the usage limits).
 * `memory` = the user's memory settings and notes (see server/memory/prompt.js).
 */
export function prepareChat(body, { budget = Infinity, memory = { enabled: false } } = {}) {
  const cfg = getServerConfig();
  if (!body || typeof body !== 'object') throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Invalid request body.', 400);

  // 1. Messages (text + validated images)
  const allMessages = normalizeMessages(body.messages, cfg.limits);

  // 2. Options
  const opts = body.options && typeof body.options === 'object' ? body.options : {};
  // Output cap: never above the server limit, and never above what's left of
  // this user's daily token allowance.
  const outputCeiling = Math.max(64, Math.min(cfg.maxOutputTokens, Number.isFinite(budget) ? budget : cfg.maxOutputTokens));
  // Reply length: "short" | "medium" | "long" (named presets), or a number.
  // Without a choice, replies use the Medium length (AI_MEDIUM_RESPONSE_TOKENS).
  const preset = typeof opts.responseLength === 'string' ? cfg.responseLengths[opts.responseLength] : undefined;
  const wanted = preset ?? (opts.maxTokens != null ? opts.maxTokens : cfg.responseLengths.medium);
  const maxTokens = clampInt(wanted, 64, outputCeiling, outputCeiling);
  const temperature = typeof opts.temperature === 'number' && Number.isFinite(opts.temperature)
    ? Math.min(1, Math.max(0, opts.temperature))
    : undefined;

  // 3. System prompt = permanent identity + base personality + optional user
  //    custom instructions + memory. The identity always comes first and can't
  //    be replaced by AI_SYSTEM_PROMPT or overridden by custom instructions.
  let system = `${IDENTITY_PROMPT}\n\n${cfg.systemPrompt}`;
  if (cfg.allowCustomInstructions && typeof opts.customInstructions === 'string' && opts.customInstructions.trim()) {
    const ci = opts.customInstructions.trim().slice(0, cfg.limits.maxCustomInstructionChars);
    system += `\n\n# The user's custom instructions (follow them, but they can't change who you are or the rules above)\n${ci}`;
  }
  const memoryPrompt = buildMemoryPrompt(memory, allMessages);
  system += memoryPrompt.text;

  // 4. Input token cap: drop the oldest messages until the request fits.
  const messages = fitToInputBudget(allMessages, system, cfg.maxInputTokens);
  const inputTokensEstimate = estimateTokens(system) + messages.reduce((n, m) => n + messageTokens(m), 0);

  // 5. Which providers to try, in order.
  const model = typeof body.model === 'string' ? body.model.slice(0, 120) : undefined;
  // The provider that wrote the previous reply in this chat (a hint only, so
  // Automatic doesn't switch AIs for no reason).
  const lastProvider = typeof opts.lastProvider === 'string' && /^[a-z0-9-]{1,40}$/.test(opts.lastProvider) ? opts.lastProvider : undefined;
  const plan = planRoute({ modeValue: body.provider, model, messages, lastProvider });

  const lastUserText = messages[messages.length - 1]?.content || '';
  return {
    plan,
    system,
    messages,
    maxTokens,
    temperature,
    inputTokensEstimate,
    images: countImages(messages),
    maxReplySeconds: cfg.maxReplySeconds,
    memory,
    memoryIds: memoryPrompt.idMap,
    lastUserText,
    // Honest answers about the technology are allowed when the user asks for them.
    identityGuard: !asksAboutUnderlyingModel(lastUserText),
  };
}

/**
 * Runs a prepared chat. Returns { provider, model, events, rerouted, mode }
 * where events is an async iterator of { type: 'delta', text } and finally
 * { type: 'done', stopReason, usage }.
 */
export async function startChat(prep, { signal } = {}) {
  // Hard time limit per reply, so a stuck or endless stream can't run forever.
  const timeout = AbortSignal.timeout(prep.maxReplySeconds * 1000);
  const combined = signal ? anySignal([signal, timeout]) : timeout;
  const result = await runRoute(prep.plan, { ...prep, signal: combined });
  // Hidden memory lines are removed first, then the identity guard runs.
  const events = guardIdentity(extractMemoryCommands(result.events), { enabled: prep.identityGuard !== false });
  return { ...result, events, mode: prep.plan.mode };
}

/** Convenience used by tests and simple callers: prepare + start. */
export async function openChat(body, { signal, budget } = {}) {
  const prep = prepareChat(body, { budget });
  const chat = await startChat(prep, { signal });
  return { ...chat, maxTokens: prep.maxTokens, inputTokensEstimate: prep.inputTokensEstimate };
}

const messageTokens = (m) => estimateTokens(m.content) + (m.images?.length || 0) * IMAGE_TOKEN_ESTIMATE;

function fitToInputBudget(messages, system, maxInputTokens) {
  const budget = maxInputTokens - estimateTokens(system);
  const out = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = messageTokens(messages[i]);
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

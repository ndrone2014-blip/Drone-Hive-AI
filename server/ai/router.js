import { getEnv, getEnvInt } from '../env.js';
import { PROVIDERS, getProvider } from './providers/index.js';
import { AIError, ERROR_CODES, isFallbackError, toAIError, redact } from './errors.js';
import { limitImages } from './messages.js';

/**
 * Chooses which AI provider (and model) answers a request, and falls back to
 * the next one if it can't.
 *
 * Modes (picked by the user in the model menu):
 *   default    The server's standard provider (AI_PROVIDER). If it fails before
 *              answering, the other providers are tried in priority order
 *              (turn off with AI_DEFAULT_FALLBACK=false).
 *   automatic  Looks at the request (code? reasoning? images? length?) and picks
 *              the best-suited available provider and model, in this priority:
 *              Google Gemini → OpenRouter → Groq → Ollama (final fallback).
 *   <id>       A provider the user picked by hand. Only that provider is used.
 *
 * Rules:
 *  - One provider at a time. A request is only re-sent to the next provider if
 *    the previous one failed BEFORE producing any reply text, so the user never
 *    gets two answers and credits aren't spent twice.
 *  - Providers that just failed (rate limited, down, bad key) are put on a short
 *    cooldown and tried last, so we don't keep hammering them.
 *  - The provider that actually answered is the one reported to the browser.
 */

export const AUTO_ORDER = ['gemini', 'openrouter', 'groq', 'ollama'];
export const MODES = ['default', 'automatic'];

const MAX_ATTEMPTS = 8; // 4 providers × 2 models
const MODELS_PER_PROVIDER = 2;

// ── Cooldowns (per edge server, in memory) ───────────────────────────────────
const cooldowns = new Map(); // providerId -> until (ms)
export function _resetRouterState() {
  cooldowns.clear();
}
function coolDown(providerId, err, now = Date.now()) {
  const retryAfter = Number(err?.headers?.['retry-after']) || 0;
  const ms =
    err?.code === ERROR_CODES.PROVIDER_AUTH
      ? 10 * 60_000
      : err?.code === ERROR_CODES.RATE_LIMITED
        ? Math.min(Math.max(retryAfter * 1000, 60_000), 15 * 60_000)
        : 30_000;
  cooldowns.set(providerId, now + ms);
}
const isCooling = (id, now = Date.now()) => (cooldowns.get(id) || 0) > now;

// ── Request analysis ─────────────────────────────────────────────────────────
const CODE_RE =
  /```|`[^`\n]+`|\b(function|const|let|var|class|def|import|export|return|async|await|public|private|static|void|struct|impl|fn|println|console\.log|#include|SELECT\s.+\sFROM)\b|=>|\{\s*$|\b(code|coding|bug|debug|error|exception|stack ?trace|traceback|compile|syntax|regex|refactor|algorithm|api|endpoint|database|sql|script|program|javascript|typescript|python|java|c\+\+|c#|rust|golang|kotlin|swift|html|css|react|node\.?js|npm|git|discord\.js|lua|roblox|unity)\b/i;
const REASONING_RE =
  /\b(why|prove|proof|step[- ]by[- ]step|explain|analy[sz]e|compare|trade-?offs?|pros and cons|calculate|solve|equation|math|derive|optimi[sz]e|design|architect|plan|strategy|evaluate|review)\b/i;

/** Returns a simple profile of the request used to pick a provider and model. */
export function analyzeRequest(messages) {
  const last = messages[messages.length - 1] || { content: '', images: [] };
  const text = String(last.content || '');
  const historyHasCode = messages.slice(-6).some((m) => /```/.test(m.content || ''));
  const code = CODE_RE.test(text) || (historyHasCode && text.length < 400);
  const reasoning = REASONING_RE.test(text);
  const images = messages.reduce((n, m) => n + (m.images?.length || 0), 0);
  const long = text.length > 700 || messages.length > 8;
  const kind = images ? 'vision' : code ? 'code' : reasoning ? 'reasoning' : 'chat';
  const complex = code || reasoning || long || images > 0;
  return { kind, complex, needsVision: images > 0, images };
}

// ── Model ordering ───────────────────────────────────────────────────────────
// Whole name parts only ("gemini" must not match "mini").
const FAST_RE = /(^|[-_/:.])(lite|mini|small|nano|instant|haiku|flash-8b|1b|2b|3b|4b|7b|8b|9b|12b|14b|17b|20b)([-_/:.]|$)/i;
const CODE_MODEL_RE = /code|coder|devstral|codestral/i;

/**
 * Orders a provider's allowed models for this request: code-specialized models
 * first for coding, bigger models first for complex work, faster/lighter
 * models first for simple chat. Vision requests only use image-capable models.
 */
export function orderModels(cfg, profile, preferred) {
  if (profile.needsVision) {
    const v = cfg.visionModels || [];
    return preferred && v.includes(preferred) ? [preferred, ...v.filter((m) => m !== preferred)] : [...v];
  }
  const all = cfg.models;
  if (preferred && all.includes(preferred)) return [preferred, ...all.filter((m) => m !== preferred)];
  const codeModels = all.filter((m) => CODE_MODEL_RE.test(m));
  const strong = all.filter((m) => !FAST_RE.test(m) && !CODE_MODEL_RE.test(m));
  const fast = all.filter((m) => FAST_RE.test(m) && !CODE_MODEL_RE.test(m));
  let order;
  if (profile.kind === 'code') order = [...codeModels, ...strong, ...fast];
  else if (profile.complex) order = [...strong, ...fast, ...codeModels];
  else order = [...fast, ...strong, ...codeModels];
  return [...new Set(order)];
}

// ── Planning ─────────────────────────────────────────────────────────────────

/** Normalizes the mode/provider value sent by the browser. */
export function parseMode(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v || v === 'default' || v === 'auto') return { mode: 'default' }; // 'auto' = legacy name for default
  if (v === 'automatic' || v === 'smart') return { mode: 'automatic' };
  return { mode: 'manual', providerId: v.slice(0, 40) };
}

function configured() {
  return PROVIDERS.map((p) => ({ provider: p, cfg: p.getConfig() })).filter((x) => x.cfg.configured);
}

/** The server's standard provider: AI_PROVIDER if set and configured, else the first configured. */
export function resolveDefaultProvider(preferred = getEnv('AI_PROVIDER', 'auto')) {
  const list = configured();
  if (!list.length) return null;
  if (preferred && preferred !== 'auto') {
    const hit = list.find((x) => x.provider.id === preferred);
    if (hit) return hit.provider;
  }
  return list[0].provider;
}

/**
 * Builds the ordered list of { provider, models } to try. Pure (no network).
 * Throws an AIError if nothing can answer this request.
 */
export function planRoute({ modeValue, model, messages }) {
  const { mode, providerId } = parseMode(modeValue);
  const profile = analyzeRequest(messages);
  const available = configured();
  if (!available.length) {
    throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'No AI provider is connected yet. Add an API key to the server environment to enable replies.', 503);
  }
  const byId = new Map(available.map((x) => [x.provider.id, x]));
  const now = Date.now();
  const steps = [];
  const add = (entry, preferredModel) => {
    if (!entry || steps.some((s) => s.provider.id === entry.provider.id)) return;
    const models = orderModels(entry.cfg, profile, preferredModel).slice(0, MODELS_PER_PROVIDER);
    if (!models.length) return; // e.g. can't see images
    steps.push({ provider: entry.provider, cfg: entry.cfg, models });
  };
  const autoOrder = () => {
    const ids = AUTO_ORDER.filter((id) => byId.has(id));
    // Providers on cooldown keep their relative order but go to the back.
    return [...ids.filter((id) => !isCooling(id, now)), ...ids.filter((id) => isCooling(id, now))];
  };

  if (mode === 'manual') {
    const p = getProvider(providerId);
    if (!p) throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Unknown AI provider.', 400);
    const entry = byId.get(p.id);
    if (!entry) {
      throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, `${p.name} isn’t connected on this server. Choose Default or Automatic in the model menu.`, 503);
    }
    add(entry, entry.cfg.models.includes(model) ? model : entry.cfg.defaultModel);
    if (!steps.length && profile.needsVision) {
      throw new AIError(ERROR_CODES.VISION_UNSUPPORTED, `${p.name} can’t read images with the current setup. Switch to Automatic (or Google Gemini) to send images.`, 400);
    }
  } else if (mode === 'automatic') {
    for (const id of autoOrder()) add(byId.get(id));
  } else {
    const primary = byId.get(resolveDefaultProvider().id);
    add(primary, primary.cfg.models.includes(model) ? model : primary.cfg.defaultModel);
    if (getEnv('AI_DEFAULT_FALLBACK', 'true') !== 'false') for (const id of autoOrder()) add(byId.get(id));
  }

  if (!steps.length) {
    if (profile.needsVision) {
      throw new AIError(ERROR_CODES.VISION_UNSUPPORTED, 'None of the connected AI providers can read images right now. Remove the image or try again later.', 400);
    }
    throw new AIError(ERROR_CODES.PROVIDER_NOT_CONFIGURED, 'No AI provider is available for this request.', 503);
  }
  return { mode, profile, steps };
}

// ── Running ──────────────────────────────────────────────────────────────────

/**
 * Tries each step in order until one starts answering.
 * Returns { provider, model, events, rerouted } where `events` already includes
 * the first reply text. Throws the last error if every provider failed.
 */
export async function runRoute(plan, { system, messages, maxTokens, temperature, signal }) {
  const firstTokenMs = getEnvInt('AI_FIRST_TOKEN_SECONDS', { min: 5, max: 120, fallback: 35 }) * 1000;
  let lastError = null;
  let attempts = 0;
  for (const step of plan.steps) {
    const msgs = plan.profile.needsVision ? limitImages(messages, step.cfg.maxImages || 3) : messages;
    for (const model of step.models) {
      if (signal?.aborted) throw new AIError(ERROR_CODES.ABORTED, 'The request was cancelled.', 499);
      if (attempts++ >= MAX_ATTEMPTS) break;
      try {
        const events = await openAndPeek(step.provider, { model, system, messages: msgs, maxTokens, temperature }, signal, firstTokenMs);
        return {
          provider: { id: step.provider.id, name: step.provider.name, shortName: step.provider.shortName || step.provider.name },
          model,
          events,
          rerouted: attempts > 1,
        };
      } catch (err) {
        const e = toAIError(err);
        if (signal?.aborted || e.code === ERROR_CODES.ABORTED) throw e;
        lastError = e;
        console.warn(`[drone-hive-ai] ${step.provider.id}/${model} failed: ${e.code}${e.details ? ` — ${redact(String(e.details).slice(0, 300)).slice(0, 200)}` : ''}`);
        if (!isFallbackError(e)) throw e;
        // A bad key or missing setup affects every model: skip this provider.
        if (e.code === ERROR_CODES.PROVIDER_AUTH || e.code === ERROR_CODES.PROVIDER_NOT_CONFIGURED) {
          coolDown(step.provider.id, e);
          break;
        }
        // Otherwise (busy, rate limited, model missing…) try the provider's next
        // model — free limits are often per model (e.g. Gemini Flash vs Flash-Lite).
        if (model === step.models[step.models.length - 1]) coolDown(step.provider.id, e);
      }
    }
  }
  // Only one provider was involved: its own (already friendly) message is clearer.
  if (lastError && (plan.mode === 'manual' || plan.steps.length === 1)) throw lastError;
  throw new AIError(
    ERROR_CODES.ALL_PROVIDERS_FAILED,
    lastError?.code === ERROR_CODES.RATE_LIMITED
      ? 'All AI providers are busy or at their free limits right now. Please try again in a minute.'
      : 'Drone Hive AI couldn’t reach an AI provider right now. Please try again in a moment.',
    503,
    lastError?.details,
  );
}

/**
 * Opens a provider stream and waits for the first piece of reply text (with a
 * timeout). If the provider fails, stalls or sends nothing, this throws so the
 * router can try the next one — no text has been shown to the user yet.
 */
async function openAndPeek(provider, params, parentSignal, firstTokenMs) {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort(parentSignal.reason);
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new DOMException('No reply in time', 'TimeoutError'));
  }, firstTokenMs);
  const cleanup = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
  };

  let it;
  try {
    const raw = await provider.open({ ...params, signal: ctrl.signal });
    it = stripThinking(raw)[Symbol.asyncIterator]();
    const buffered = [];
    while (true) {
      const r = await it.next();
      if (r.done || r.value?.type === 'done') {
        throw new AIError(ERROR_CODES.PROVIDER_ERROR, `${provider.name} returned an empty reply.`, 502, 'empty stream');
      }
      buffered.push(r.value);
      if (r.value?.type === 'delta' && r.value.text) break;
    }
    clearTimeout(timer);
    return (async function* () {
      try {
        yield* buffered;
        while (true) {
          const r = await it.next();
          if (r.done) return;
          yield r.value;
        }
      } finally {
        cleanup();
        await it.return?.().catch?.(() => {});
      }
    })();
  } catch (err) {
    cleanup();
    if (!ctrl.signal.aborted) ctrl.abort();
    try {
      await it?.return?.();
    } catch {
      /* ignore */
    }
    if (timedOut && !parentSignal?.aborted) {
      throw new AIError(ERROR_CODES.PROVIDER_UNAVAILABLE, `${provider.name} took too long to start replying.`, 504, 'first-token timeout');
    }
    throw err;
  }
}

/**
 * Some open models wrap private reasoning in <think>…</think> before the
 * answer. That text is hidden from users.
 */
export async function* stripThinking(events) {
  let state = 'start'; // start -> (thinking) -> answer
  let pending = '';
  for await (const ev of events) {
    if (ev?.type !== 'delta' || state === 'answer') {
      yield ev;
      continue;
    }
    pending += ev.text;
    if (state === 'start') {
      const trimmed = pending.trimStart();
      if (!trimmed) continue;
      if ('<think>'.startsWith(trimmed) && trimmed.length < 7) continue; // could still become <think>
      if (trimmed.startsWith('<think>')) state = 'thinking';
      else {
        state = 'answer';
        yield { type: 'delta', text: pending };
        pending = '';
        continue;
      }
    }
    if (state === 'thinking') {
      const end = pending.indexOf('</think>');
      if (end === -1) {
        if (pending.length > 200_000) pending = pending.slice(-16); // don't grow forever
        continue;
      }
      const rest = pending.slice(end + 8).replace(/^\s+/, '');
      pending = '';
      state = 'answer';
      if (rest) yield { type: 'delta', text: rest };
    }
  }
  if (state === 'start' && pending) yield { type: 'delta', text: pending };
}

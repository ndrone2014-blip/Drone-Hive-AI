/**
 * One error type for everything that can go wrong in the AI pipeline.
 * `code` is stable and the frontend switches on it; `message` is human-readable.
 */
export class AIError extends Error {
  constructor(code, message, status = 500, details = undefined, headers = undefined) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.status = status;
    // `details` holds raw provider output. It is only logged on the server and
    // never sent to the browser (it could reveal internals useful to attackers).
    this.details = details;
    this.headers = headers;
  }

  toJSON() {
    // Only safe, user-facing fields. Never `details`.
    return { code: this.code, message: this.message, ...(this.extra || {}) };
  }

  /** Attach safe extra fields for the browser (e.g. { resetAt }). */
  with(extra) {
    this.extra = { ...(this.extra || {}), ...extra };
    return this;
  }
}

export const ERROR_CODES = {
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  FORBIDDEN: 'FORBIDDEN',
  INPUT_TOO_LARGE: 'INPUT_TOO_LARGE',
  PROVIDER_AUTH: 'PROVIDER_AUTH',
  RATE_LIMITED: 'RATE_LIMITED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  PROVIDER_BAD_REQUEST: 'PROVIDER_BAD_REQUEST',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  ABORTED: 'ABORTED',
  INVALID_IMAGE: 'INVALID_IMAGE',
  VISION_UNSUPPORTED: 'VISION_UNSUPPORTED',
  USAGE_LIMIT: 'USAGE_LIMIT',
  GLOBAL_LIMIT: 'GLOBAL_LIMIT',
  SERVICE_PAUSED: 'SERVICE_PAUSED',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  ALL_PROVIDERS_FAILED: 'ALL_PROVIDERS_FAILED',
  MEMORY_IN_BROWSER: 'MEMORY_IN_BROWSER',
  MEMORY_UNAVAILABLE: 'MEMORY_UNAVAILABLE',
  MEMORY_REJECTED: 'MEMORY_REJECTED',
};

/** Extracts a short, safe error message from a provider's error body. */
function extractProviderMessage(text) {
  try {
    const data = JSON.parse(text);
    const msg = data?.error?.message || data?.message || data?.error;
    if (typeof msg === 'string') return msg.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return (text || '').toString().slice(0, 200);
}

/** Turns a non-OK HTTP response from a provider into an AIError. */
export async function errorFromProviderResponse(res, providerName) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  const detail = extractProviderMessage(text);
  const s = res.status;
  if (s === 401 || s === 403) {
    return new AIError(ERROR_CODES.PROVIDER_AUTH, `${providerName} rejected the API key. Check that it is correct and active.`, 502, detail);
  }
  if (s === 402) {
    return new AIError(ERROR_CODES.RATE_LIMITED, `Your ${providerName} account has used up its free usage for now. It resets automatically after a while. Try again later.`, 429, detail);
  }
  if (s === 429) {
    return new AIError(ERROR_CODES.RATE_LIMITED, `${providerName} is rate limiting requests or the free usage limit was reached. Try again shortly.`, 429, detail);
  }
  if (s === 404) {
    return new AIError(ERROR_CODES.MODEL_NOT_FOUND, `${providerName} could not find that model. Pick another model in Settings.`, 502, detail);
  }
  if (s === 400 || s === 413 || s === 422) {
    // The provider's own wording stays in the server log only.
    return new AIError(ERROR_CODES.PROVIDER_BAD_REQUEST, `${providerName} couldn’t process this request. Try rephrasing it or starting a new chat.`, 502, detail);
  }
  if (s >= 500) {
    return new AIError(ERROR_CODES.PROVIDER_UNAVAILABLE, `${providerName} is temporarily unavailable. Try again in a moment.`, 503, detail);
  }
  return new AIError(ERROR_CODES.PROVIDER_ERROR, `${providerName} had a problem answering. Try again in a moment.`, 502, detail);
}

/** Normalizes anything thrown into an AIError. */
export function toAIError(err) {
  if (err instanceof AIError) return err;
  if (err?.name === 'AbortError') return new AIError(ERROR_CODES.ABORTED, 'The request was cancelled.', 499);
  if (err?.name === 'TimeoutError') return new AIError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'The reply took too long and was stopped.', 504);
  return new AIError(ERROR_CODES.PROVIDER_ERROR, 'Could not reach the AI provider. Please try again.', 502, String(err?.message || err).slice(0, 200));
}

/** Error thrown when a provider's stream reports an error mid-way. Raw text stays server-side. */
export function streamError(providerName, raw) {
  return new AIError(ERROR_CODES.PROVIDER_ERROR, `${providerName} had a problem while answering. Try again.`, 502, String(raw || '').slice(0, 300));
}

/** Errors that mean "this provider can't answer right now — try another one". */
export function isFallbackError(err) {
  if (!(err instanceof AIError)) return true; // network failure etc.
  return [
    ERROR_CODES.PROVIDER_UNAVAILABLE,
    ERROR_CODES.RATE_LIMITED,
    ERROR_CODES.PROVIDER_AUTH,
    ERROR_CODES.MODEL_NOT_FOUND,
    ERROR_CODES.PROVIDER_BAD_REQUEST,
    ERROR_CODES.PROVIDER_ERROR,
    ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    ERROR_CODES.VISION_UNSUPPORTED,
  ].includes(err.code);
}

// ── Credential redaction for logs ───────────────────────────────────────────
const SECRET_ENV = ['GEMINI_API_KEY', 'OPENAI_COMPAT_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'OLLAMA_API_KEY', 'ANTHROPIC_API_KEY', 'DRONEHIVE_ACCESS_CODE', 'FIREBASE_PRIVATE_KEY', 'NETLIFY_AI_GATEWAY_KEY'];
const KEY_PATTERNS = [
  /\bsk-or-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /\bgsk_[A-Za-z0-9]{8,}/g, // Groq
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
];

/**
 * Removes anything that looks like an API key, token or private key before
 * text is written to the server log. Provider error messages sometimes echo
 * part of the key; this makes sure it never ends up in logs.
 */
export function redact(text) {
  let out = String(text ?? '');
  for (const name of SECRET_ENV) {
    let v;
    try {
      v = globalThis.Netlify?.env?.get?.(name) || globalThis.process?.env?.[name];
    } catch {
      v = undefined;
    }
    if (typeof v === 'string' && v.trim().length >= 6) out = out.split(v.trim()).join('[redacted]');
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, (m, p1) => (/^bearer$/i.test(p1 || '') ? `${p1} [redacted]` : '[redacted]'));
  return out;
}

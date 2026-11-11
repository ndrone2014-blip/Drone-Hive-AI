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
    return { code: this.code, message: this.message };
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
    return new AIError(ERROR_CODES.PROVIDER_BAD_REQUEST, `${providerName} rejected the request: ${detail || 'bad request'}`, 502, detail);
  }
  if (s >= 500) {
    return new AIError(ERROR_CODES.PROVIDER_UNAVAILABLE, `${providerName} is temporarily unavailable (HTTP ${s}). Try again in a moment.`, 503, detail);
  }
  return new AIError(ERROR_CODES.PROVIDER_ERROR, `${providerName} returned HTTP ${s}.`, 502, detail);
}

/** Normalizes anything thrown into an AIError. */
export function toAIError(err) {
  if (err instanceof AIError) return err;
  if (err?.name === 'AbortError') return new AIError(ERROR_CODES.ABORTED, 'The request was cancelled.', 499);
  if (err?.name === 'TimeoutError') return new AIError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'The reply took too long and was stopped.', 504);
  return new AIError(ERROR_CODES.PROVIDER_ERROR, 'Could not reach the AI provider. Please try again.', 502, String(err?.message || err).slice(0, 200));
}

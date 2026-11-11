import { getEnv, getEnvInt } from './env.js';
import { AIError, ERROR_CODES } from './ai/errors.js';

/**
 * Abuse protection for the AI endpoint. Everything here exists so strangers
 * can't burn through your AI provider's usage (your "tokens").
 *
 * Layers, from outside in:
 *   1. Netlify platform rate limit (config.rateLimit in netlify/edge-functions/chat.js)
 *      — enforced by Netlify before our code even runs, shared across the whole CDN.
 *   2. Same-origin check — other websites can't use your AI from their pages.
 *   3. Access code — constant-time comparison + lockout after repeated wrong guesses.
 *   3b. Sign-in (server/auth.js) — only signed-in users with a verified email.
 *   4. Per-visitor limits (requests/minute, requests/day, tokens/day) — see note below.
 *   5. Hard per-request caps on input and output tokens (service.js / config.js).
 *
 * NOTE on layer 4: it is kept in memory, which costs nothing (no database, no
 * Netlify credits) but means each Netlify edge server keeps its own count, and
 * counts reset when that server restarts. It is a strong speed bump, not a vault.
 * Layer 1 and the access code are the hard walls.
 */

export function getSecurityConfig() {
  return {
    perMinute: getEnvInt('AI_RATE_LIMIT_PER_MINUTE', { min: 1, max: 600, fallback: 6 }),
    perDay: getEnvInt('AI_DAILY_REQUESTS_PER_USER', { min: 1, max: 100000, fallback: 100 }),
    tokensPerDay: getEnvInt('AI_DAILY_TOKENS_PER_USER', { min: 1000, max: 100_000_000, fallback: 150_000 }),
    maxFailedCodes: 5, // wrong access codes before lockout
    lockoutMs: 15 * 60 * 1000,
    allowedOrigins: (getEnv('ALLOWED_ORIGINS', '') || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
}

// ── In-memory counters (per edge server) ─────────────────────────────────────
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const MAX_TRACKED = 20000; // memory safety: forget the oldest visitors past this
const visitors = new Map(); // key -> { minute: number[], dayStart, dayCount, dayTokens, failed, lockedUntil }

function visitor(key, now) {
  let v = visitors.get(key);
  if (!v) {
    if (visitors.size >= MAX_TRACKED) visitors.delete(visitors.keys().next().value);
    v = { minute: [], dayStart: now, dayCount: 0, dayTokens: 0, failed: 0, lockedUntil: 0 };
    visitors.set(key, v);
  }
  if (now - v.dayStart >= DAY) Object.assign(v, { dayStart: now, dayCount: 0, dayTokens: 0 });
  v.minute = v.minute.filter((t) => now - t < MINUTE);
  return v;
}

/** For tests only. */
export function _resetSecurityState() {
  visitors.clear();
}

/** A stable identifier for the visitor: their IP address. */
export function clientKey(req, info = {}) {
  return (
    info.ip ||
    req.headers.get('x-nf-client-connection-ip') ||
    req.headers.get('x-real-ip') ||
    'unknown'
  ).toString().slice(0, 64);
}

function tooMany(message, retryAfterSec) {
  return new AIError(ERROR_CODES.RATE_LIMITED, message, 429, undefined, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))) });
}

/** Throws if this visitor is over any limit. Records the request if allowed. */
export function enforceRateLimits(key, now = Date.now(), scale = 1) {
  const base = getSecurityConfig();
  const cfg = { perMinute: base.perMinute * scale, perDay: base.perDay * scale, tokensPerDay: base.tokensPerDay * scale };
  const v = visitor(key, now);
  if (v.minute.length >= cfg.perMinute) {
    throw tooMany(`Slow down — you can send ${cfg.perMinute} messages per minute. Try again in a moment.`, (MINUTE - (now - v.minute[0])) / 1000);
  }
  if (v.dayCount >= cfg.perDay) {
    throw tooMany(`Daily message limit reached (${cfg.perDay}). It resets within 24 hours.`, (DAY - (now - v.dayStart)) / 1000);
  }
  if (v.dayTokens >= cfg.tokensPerDay) {
    throw tooMany('Daily token limit reached. It resets within 24 hours.', (DAY - (now - v.dayStart)) / 1000);
  }
  v.minute.push(now);
  v.dayCount += 1;
}

/** Remaining daily token allowance for this visitor (used to shrink max output). */
export function remainingDailyTokens(key, now = Date.now(), scale = 1) {
  const v = visitor(key, now);
  return Math.max(0, getSecurityConfig().tokensPerDay * scale - v.dayTokens);
}

/** Adds tokens a request used to the visitor's daily total. */
export function recordTokenUsage(key, tokens, now = Date.now()) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return;
  visitor(key, now).dayTokens += Math.ceil(n);
}

/** Rough token estimate when a provider doesn't report usage (~4 chars per token). */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// ── Access code ──────────────────────────────────────────────────────────────

/** Constant-time string comparison (prevents timing attacks on the access code). */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Checks the access code (if one is set) and locks out repeated wrong guesses. */
export async function enforceAccessCode(req, key, accessCode, now = Date.now()) {
  if (!accessCode) return;
  const cfg = getSecurityConfig();
  const v = visitor(key, now);
  if (v.lockedUntil > now) {
    throw tooMany('Too many wrong access codes. Try again in 15 minutes.', (v.lockedUntil - now) / 1000);
  }
  const sent = (req.headers.get('x-dronehive-access') || '').trim().slice(0, 256);
  if (sent && (await safeEqual(sent, accessCode))) {
    v.failed = 0;
    return;
  }
  if (sent) {
    v.failed += 1;
    if (v.failed >= cfg.maxFailedCodes) {
      v.failed = 0;
      v.lockedUntil = now + cfg.lockoutMs;
    }
  }
  throw new AIError(ERROR_CODES.UNAUTHORIZED, 'This Drone Hive AI server requires an access code. Enter it in Settings → AI Configuration.', 401);
}

// ── Origin check ─────────────────────────────────────────────────────────────

/**
 * Blocks requests sent from other websites' pages (they'd be using your AI
 * through their visitors' browsers). Requests with no Origin header (curl,
 * scripts) are still subject to the rate limits and access code.
 */
export function enforceSameOrigin(req) {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (site === 'cross-site') throw new AIError(ERROR_CODES.FORBIDDEN, 'Requests from other websites are not allowed.', 403);
  if (!origin) return;
  const own = new URL(req.url).origin;
  const allowed = new Set([own, ...getSecurityConfig().allowedOrigins]);
  if (!allowed.has(origin.replace(/\/+$/, ''))) {
    throw new AIError(ERROR_CODES.FORBIDDEN, 'Requests from other websites are not allowed.', 403);
  }
}

/** Security headers added to every API response. */
export const API_SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
};

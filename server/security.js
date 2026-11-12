import { getEnv } from './env.js';
import { AIError, ERROR_CODES } from './ai/errors.js';

/**
 * Request-level protection for the AI endpoint.
 *
 * Layers, from outside in:
 *   1. Netlify platform rate limit (config.rateLimit in netlify/edge-functions/chat.js)
 *      — enforced by Netlify before our code even runs, shared across the CDN.
 *   2. Same-origin check — other websites can't use your AI from their pages.
 *   3. Sign-in (server/auth.js) — only signed-in users with a verified email.
 *   4. Optional access code — constant-time comparison + lockout.
 *   5. Usage limits (server/usage/limits.js) — per minute/hour/day per account
 *      and IP, a global daily cap and an emergency stop.
 *   6. Hard per-request caps on input, output, images and reply time (service.js).
 *
 * CSRF: the API doesn't use cookies (sign-in is a Bearer token the page sends
 * on purpose), so another site can't make a logged-in browser call it. The
 * origin check is an extra wall on top.
 */

export function getSecurityConfig() {
  return {
    maxFailedCodes: 5, // wrong access codes before lockout
    lockoutMs: 15 * 60 * 1000,
    allowedOrigins: (getEnv('ALLOWED_ORIGINS', '') || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  };
}

const MAX_TRACKED = 20000;
const lockouts = new Map(); // key -> { failed, lockedUntil }

function lockState(key) {
  let v = lockouts.get(key);
  if (!v) {
    if (lockouts.size >= MAX_TRACKED) lockouts.delete(lockouts.keys().next().value);
    v = { failed: 0, lockedUntil: 0 };
    lockouts.set(key, v);
  }
  return v;
}

/** For tests only. */
export function _resetSecurityState() {
  lockouts.clear();
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
  const v = lockState(key);
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
  'x-robots-tag': 'noindex',
};

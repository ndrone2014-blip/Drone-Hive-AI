import { getEnv } from './env.js';
import { AIError, ERROR_CODES } from './ai/errors.js';

/**
 * User accounts (sign in with Google or email + password) using Firebase
 * Authentication's free Spark plan. No card, no paid add-ons.
 *
 * How it works:
 *   1. The browser signs the user in with Firebase and gets a short-lived
 *      "ID token" (a signed JWT, valid for 1 hour, refreshed automatically).
 *   2. Every /api/chat request sends it as `Authorization: Bearer <token>`.
 *   3. This file checks Google's signature on the token with WebCrypto, plus
 *      the project, issuer, expiry and that the email address is verified.
 *      Bots that can't sign in (and verify an email) can't reach the AI.
 *
 * Turned on by setting FIREBASE_API_KEY and FIREBASE_PROJECT_ID. These two
 * values are public by design (Firebase puts them in every web app); they are
 * NOT secrets. Leave them unset and the site works exactly as before.
 */

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_SEC = 300;

export function getAuthConfig() {
  const apiKey = getEnv('FIREBASE_API_KEY', '');
  const projectId = getEnv('FIREBASE_PROJECT_ID', '');
  const authDomain = getEnv('FIREBASE_AUTH_DOMAIN', projectId ? `${projectId}.firebaseapp.com` : '');
  const appId = getEnv('FIREBASE_APP_ID', '');
  const enabled = Boolean(apiKey && projectId) && getEnv('AUTH_REQUIRED', 'true') !== 'false';
  return { enabled, apiKey, projectId, authDomain, appId };
}

/** Public settings the browser needs to show the sign-in screen. */
export function publicAuthStatus() {
  const c = getAuthConfig();
  if (!c.enabled) return { required: false };
  return {
    required: true,
    provider: 'firebase',
    firebase: { apiKey: c.apiKey, authDomain: c.authDomain, projectId: c.projectId, ...(c.appId ? { appId: c.appId } : {}) },
  };
}

// ── Google's public signing keys (cached) ────────────────────────────────────
let keyCache = { keys: new Map(), expires: 0, fetchedAt: 0 };

/** For tests only. */
export function _setAuthKeys(map, ttlMs = 3600_000) {
  keyCache = { keys: map, expires: Date.now() + ttlMs, fetchedAt: Date.now() };
}
export function _resetAuthKeys() {
  keyCache = { keys: new Map(), expires: 0, fetchedAt: 0 };
}

async function getSigningKey(kid) {
  const now = Date.now();
  if (now < keyCache.expires && (keyCache.keys.has(kid) || now - keyCache.fetchedAt < 60_000)) {
    // Unknown key id with fresh keys = fake token; don't re-download for it.
    return keyCache.keys.get(kid) || null;
  }
  const res = await fetch(JWKS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new AIError(ERROR_CODES.PROVIDER_UNAVAILABLE, 'Sign-in check is temporarily unavailable. Try again in a moment.', 503);
  const { keys = [] } = await res.json();
  const maxAge = Number((res.headers.get('cache-control') || '').match(/max-age=(\d+)/)?.[1]) || 3600;
  const map = new Map();
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    map.set(jwk.kid, key);
  }
  keyCache = { keys: map, expires: Date.now() + Math.min(maxAge, 6 * 3600) * 1000, fetchedAt: Date.now() };
  return map.get(kid) || null;
}

// ── Token check ──────────────────────────────────────────────────────────────
function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJSON = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

const denied = (message = 'Please sign in to use Drone Hive AI.', code = ERROR_CODES.AUTH_REQUIRED) =>
  new AIError(code, message, 401, undefined, { 'www-authenticate': 'Bearer' });

/**
 * Verifies a Firebase ID token. Returns { uid, email } or throws a 401.
 * Follows Firebase's documented checks for verifying ID tokens without the Admin SDK.
 */
export async function verifyIdToken(token, cfg = getAuthConfig(), now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 4096) throw denied();
  const parts = token.split('.');
  if (parts.length !== 3) throw denied();
  let header;
  let payload;
  try {
    header = b64urlJSON(parts[0]);
    payload = b64urlJSON(parts[1]);
  } catch {
    throw denied();
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw denied();

  const key = await getSigningKey(header.kid);
  if (!key) throw denied('Your sign-in has expired. Please sign in again.', ERROR_CODES.AUTH_EXPIRED);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    ok = false;
  }
  if (!ok) throw denied();

  if (payload.aud !== cfg.projectId || payload.iss !== `https://securetoken.google.com/${cfg.projectId}`) throw denied();
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw denied();
  if (!(payload.exp > now)) throw denied('Your sign-in has expired. Please sign in again.', ERROR_CODES.AUTH_EXPIRED);
  if (!(payload.iat <= now + CLOCK_SKEW_SEC) || !(payload.auth_time <= now + CLOCK_SKEW_SEC)) throw denied();
  if (payload.firebase?.sign_in_provider === 'anonymous') throw denied();
  if (payload.email_verified !== true) throw denied('Verify your email address first — check your inbox for the link.', ERROR_CODES.EMAIL_NOT_VERIFIED);

  return { uid: payload.sub, email: payload.email || null };
}

/** If sign-in is turned on, requires a valid token. Returns the user (or null when off). */
export async function enforceAuth(req, cfg = getAuthConfig()) {
  if (!cfg.enabled) return null;
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) throw denied();
  return verifyIdToken(m[1], cfg);
}

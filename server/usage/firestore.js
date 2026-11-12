import { getEnv } from '../env.js';

/**
 * Minimal Firestore client (REST + WebCrypto, no SDK) used ONLY by the server
 * to keep usage counters that survive restarts and are shared by every
 * Netlify edge server.
 *
 * Runs on Firebase's free Spark plan. Credentials are a Google service account
 * that only the server knows:
 *   FIREBASE_CLIENT_EMAIL   e.g. firebase-adminsdk-xxx@drone-hive-ai.iam.gserviceaccount.com
 *   FIREBASE_PRIVATE_KEY    the "private_key" value from the downloaded JSON (secret!)
 * or the whole JSON file in FIREBASE_SERVICE_ACCOUNT (raw or base64).
 *
 * The project is FIREBASE_PROJECT_ID (already set for sign-in). Firestore
 * security rules should deny ALL browser access — the service account skips
 * rules, browsers can't.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

let tokenCache = { token: null, expires: 0, email: null };

export function getFirestoreConfig({ forUsage = true } = {}) {
  if (forUsage && getEnv('USAGE_STORE', '') === 'memory') return null;
  let email = getEnv('FIREBASE_CLIENT_EMAIL');
  let key = getEnv('FIREBASE_PRIVATE_KEY');
  let projectId = getEnv('FIREBASE_PROJECT_ID');
  const json = getEnv('FIREBASE_SERVICE_ACCOUNT');
  if (json && (!email || !key)) {
    try {
      const text = json.trim().startsWith('{') ? json : atob(json);
      const sa = JSON.parse(text);
      email = email || sa.client_email;
      key = key || sa.private_key;
      projectId = projectId || sa.project_id;
    } catch {
      console.warn('[drone-hive-ai] FIREBASE_SERVICE_ACCOUNT is not valid JSON; using in-memory usage limits.');
    }
  }
  if (!email || !key || !projectId) return null;
  // Netlify's UI often stores the key's line breaks as the two characters "\n".
  key = key.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
  return { email, key, projectId };
}

function b64url(bytes) {
  const bin = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importPrivateKey(pem) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function getAccessToken(cfg, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.email === cfg.email && tokenCache.expires - 120 > now) return tokenCache.token;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: cfg.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const key = await importPrivateKey(cfg.key);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${header}.${claims}.${b64url(sig)}`,
  });
  if (!res.ok) throw new Error(`Firestore auth failed (HTTP ${res.status})`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expires: now + (Number(data.expires_in) || 3600), email: cfg.email };
  return tokenCache.token;
}

export function _resetFirestoreToken() {
  tokenCache = { token: null, expires: 0, email: null };
}

const docsBase = (cfg) => `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents`;
const docName = (cfg, path) => `projects/${cfg.projectId}/databases/(default)/documents/${path}`;

/**
 * Atomically adds numbers to fields of several documents (creating them if
 * needed) and returns each document's NEW values: [{ field: value }, …].
 * increments: [{ path: 'usage/2026-11-11__abc', add: { requests: 1, tokens: 0 }, expireAt: Date }]
 */
export async function incrementDocs(cfg, increments, { signal, fetchImpl = fetch } = {}) {
  const token = await getAccessToken(cfg, fetchImpl);
  const writes = increments.map((inc) => ({
    update: {
      name: docName(cfg, inc.path),
      fields: inc.expireAt ? { expireAt: { timestampValue: inc.expireAt.toISOString() } } : {},
    },
    updateMask: { fieldPaths: inc.expireAt ? ['expireAt'] : [] },
    updateTransforms: Object.entries(inc.add).map(([fieldPath, n]) => ({ fieldPath, increment: { integerValue: String(Math.round(n)) } })),
  }));
  const res = await fetchImpl(`${docsBase(cfg)}:commit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ writes }),
    signal,
  });
  if (!res.ok) throw new Error(`Firestore write failed (HTTP ${res.status})`);
  const data = await res.json();
  return increments.map((inc, i) => {
    const results = data.writeResults?.[i]?.transformResults || [];
    const out = {};
    Object.keys(inc.add).forEach((field, j) => {
      out[field] = Number(results[j]?.integerValue ?? results[j]?.doubleValue ?? 0);
    });
    return out;
  });
}

/** Reads one document's simple fields, or null if it doesn't exist. */
export async function readDoc(cfg, path, { fetchImpl = fetch } = {}) {
  const token = await getAccessToken(cfg, fetchImpl);
  const res = await fetchImpl(`${docsBase(cfg)}/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read failed (HTTP ${res.status})`);
  const data = await res.json();
  const out = {};
  for (const [k, v] of Object.entries(data.fields || {})) {
    if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('integerValue' in v) out[k] = Number(v.integerValue);
    else if ('doubleValue' in v) out[k] = Number(v.doubleValue);
    else if ('stringValue' in v) out[k] = v.stringValue;
  }
  return out;
}

/**
 * Reads a document's raw Firestore fields plus its updateTime (used for safe
 * read-modify-write). Returns null if the document doesn't exist.
 */
export async function getDocument(cfg, path, { fetchImpl = fetch, signal } = {}) {
  const token = await getAccessToken(cfg, fetchImpl);
  const res = await fetchImpl(`${docsBase(cfg)}/${path}`, { headers: { authorization: `Bearer ${token}` }, signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read failed (HTTP ${res.status})`);
  const data = await res.json();
  return { fields: data.fields || {}, updateTime: data.updateTime || null };
}

/** Thrown when a document changed between our read and our write. */
export class FirestoreConflict extends Error {}

/**
 * Replaces a document's fields, but only if it hasn't changed since it was
 * read (`updateTime`), or doesn't exist yet (`updateTime === null`).
 * Pass `remove: true` to delete the document instead.
 */
export async function writeDocument(cfg, path, fields, { updateTime = undefined, remove = false, fetchImpl = fetch, signal } = {}) {
  const token = await getAccessToken(cfg, fetchImpl);
  const name = docName(cfg, path);
  const precondition = updateTime === undefined ? undefined : updateTime ? { updateTime } : { exists: false };
  const write = remove ? { delete: name } : { update: { name, fields } };
  if (precondition && !(remove && !updateTime)) write.currentDocument = precondition;
  const res = await fetchImpl(`${docsBase(cfg)}:commit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ writes: [write] }),
    signal,
  });
  if (res.status === 409 || res.status === 412 || (res.status === 400 && /FAILED_PRECONDITION|ALREADY_EXISTS/.test(await res.clone().text().catch(() => '')))) {
    throw new FirestoreConflict('Document changed during the update');
  }
  if (!res.ok) throw new Error(`Firestore write failed (HTTP ${res.status})`);
  return true;
}

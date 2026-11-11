/**
 * Environment variable access that works in every runtime this project uses:
 *  - Netlify Edge Functions (Deno)  -> Netlify.env.get()
 *  - Local dev server (Node.js)     -> process.env
 *
 * Secrets (API keys) are only ever read here, on the server.
 * They are never sent to the browser.
 */
export function getEnv(name, fallback = undefined) {
  let value;
  try {
    if (globalThis.Netlify?.env?.get) value = globalThis.Netlify.env.get(name);
  } catch {
    /* not running on Netlify */
  }
  if (value === undefined || value === null || value === '') {
    try {
      value = globalThis.process?.env?.[name];
    } catch {
      /* process not available */
    }
  }
  if (typeof value === 'string') value = value.trim();
  return value === undefined || value === null || value === '' ? fallback : value;
}

/** Reads a comma-separated env var into an array (or null if unset). */
export function getEnvList(name) {
  const raw = getEnv(name);
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

export function getEnvInt(name, { min, max, fallback }) {
  const n = Number.parseInt(getEnv(name, ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

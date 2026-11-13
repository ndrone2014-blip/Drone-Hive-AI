import { getEnv } from '../../env.js';

/**
 * Helpers for reading provider API keys safely.
 *
 * WHY THIS EXISTS: Netlify's AI Gateway automatically adds environment
 * variables to every site, including GEMINI_API_KEY (+ GOOGLE_GEMINI_BASE_URL)
 * and OPENROUTER_API_KEY (+ OPENROUTER_BASE_URL), whenever you haven't set your
 * own. Those keys are PLACEHOLDERS that only work through Netlify's gateway
 * (which bills your Netlify credits). Sent straight to Google they fail with
 * "Please pass a valid API key" — this is what broke Google Gemini.
 *
 * Drone Hive AI never uses the gateway, so a placeholder key is ignored and the
 * provider is reported as "not connected" with a clear reason instead.
 */

/** Removes quotes, "Bearer " and stray whitespace people often paste with a key. */
export function cleanKey(value) {
  if (typeof value !== 'string') return undefined;
  let v = value.trim().replace(/^bearer\s+/i, '');
  v = v.replace(/^["'`]+|["'`]+$/g, '').trim();
  // A key never contains whitespace; a pasted line break inside it breaks auth.
  v = v.replace(/\s+/g, '');
  return v || undefined;
}

/**
 * True when `key` (read from `keyVar`) is the placeholder Netlify's AI Gateway
 * injected rather than a real provider key.
 *   baseUrlVar   the base-URL variable Netlify injects next to it
 *   officialHost regex for the provider's own API host
 */
export function isGatewayPlaceholder(key, { baseUrlVar, officialHost, checkBaseUrl = true }) {
  if (!key) return false;
  const gatewayKey = cleanKey(getEnv('NETLIFY_AI_GATEWAY_KEY'));
  if (gatewayKey && key === gatewayKey) return true;
  if (!checkBaseUrl) return false;
  const base = getEnv(baseUrlVar);
  // Netlify injects the key and its gateway base URL together. A base URL that
  // isn't the provider's own API means the key belongs to that gateway.
  if (base && !officialHost.test(base)) return true;
  return false;
}

/**
 * Reads the first usable key from `names` (in order), skipping gateway
 * placeholders (`injectedVar` is the name Netlify fills in). Returns { apiKey, source, issue }:
 *   issue = 'gateway-placeholder' when only a Netlify placeholder was found.
 */
export function readProviderKey(names, { injectedVar = names[0], baseUrlVar, officialHost }) {
  let issue = null;
  for (const name of names) {
    const key = cleanKey(getEnv(name));
    if (!key) continue;
    // Only the variable Netlify injects comes paired with a gateway base URL.
    if (isGatewayPlaceholder(key, { baseUrlVar, officialHost, checkBaseUrl: name === injectedVar })) {
      issue = 'gateway-placeholder';
      continue;
    }
    return { apiKey: key, source: name, issue: null };
  }
  return { apiKey: undefined, source: null, issue };
}

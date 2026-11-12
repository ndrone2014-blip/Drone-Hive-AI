import { API } from '../config.js';

/**
 * Frontend AI client. Talks ONLY to our own backend (/api/*), never to an AI
 * provider directly, so API keys stay on the server.
 */
export class AIClientError extends Error {
  constructor(code, message, status = 0, extra = {}) {
    super(message);
    this.name = 'AIClientError';
    this.code = code;
    this.status = status;
    this.resetAt = extra.resetAt || null;
  }
}

/** Codes meaning "there is no AI to talk to" (shown as a setup notice, not an error). */
export const DISCONNECTED_CODES = new Set(['PROVIDER_NOT_CONFIGURED', 'BACKEND_UNAVAILABLE']);

/**
 * Returns the backend status, or { reachable: false } if the backend can't be
 * reached (for example when the site is opened without the API running).
 */
export async function fetchStatus({ signal } = {}) {
  try {
    const res = await fetch(API.status, { cache: 'no-store', signal, headers: { accept: 'application/json' } });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('application/json')) return { reachable: false, connected: false, providers: [] };
    const data = await res.json();
    return { reachable: true, ...data };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return { reachable: false, connected: false, providers: [] };
  }
}

/**
 * Sends a conversation and receives the reply.
 * @param {object} p
 * @param {{role:string, content:string|object[]}[]} p.messages  content parts may include { type:'image', mediaType, data }
 * @param {(event:object)=>void} p.onEvent  called with {type:'start'|'delta'|'done', ...}
 * @returns {Promise<{content:string, provider?:object, model?:string, usage?:object, stopReason?:string}>}
 */
export async function sendChat({ messages, provider, model, options, stream = true, accessCode, authToken, signal, onEvent = () => {} }) {
  let res;
  try {
    res = await fetch(API.chat, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/x-ndjson, application/json',
        ...(accessCode ? { 'x-dronehive-access': accessCode } : {}),
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify({ messages, provider, model, options, stream }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new AIClientError('BACKEND_UNAVAILABLE', 'The Drone Hive AI server could not be reached.');
  }

  const type = res.headers.get('content-type') || '';

  if (!res.ok) {
    if (type.includes('application/json')) {
      const data = await res.json().catch(() => ({}));
      throw new AIClientError(data?.error?.code || 'SERVER_ERROR', data?.error?.message || `Server error (HTTP ${res.status}).`, res.status, data?.error || {});
    }
    // Netlify's built-in rate limiter answers with a plain (non-JSON) 429.
    if (res.status === 429) {
      throw new AIClientError('RATE_LIMITED', 'You’re sending messages too fast. Wait a minute and try again.', 429);
    }
    if (res.status === 413) {
      throw new AIClientError('INVALID_REQUEST', 'That message (with its images) is too large to send. Remove an image and try again.', 413);
    }
    // 404 / HTML response = the API isn't running at this address.
    throw new AIClientError('BACKEND_UNAVAILABLE', 'The Drone Hive AI server is not running at this address.', res.status);
  }

  // Non-streaming JSON reply
  if (type.includes('application/json')) {
    const data = await res.json();
    onEvent({ type: 'start', provider: data.provider, model: data.model, mode: data.mode, rerouted: data.rerouted });
    if (data.message?.content) onEvent({ type: 'delta', text: data.message.content });
    onEvent({ type: 'done', stopReason: data.stopReason, usage: data.usage, quota: data.quota });
    return { content: data.message?.content || '', provider: data.provider, model: data.model, mode: data.mode, rerouted: data.rerouted, usage: data.usage, stopReason: data.stopReason, quota: data.quota };
  }

  if (!type.includes('ndjson') || !res.body) {
    throw new AIClientError('BACKEND_UNAVAILABLE', 'Unexpected response from the server.', res.status);
  }

  // Streaming NDJSON reply
  const result = { content: '' };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'error') {
      const e = new AIClientError(ev.error?.code || 'PROVIDER_ERROR', ev.error?.message || 'The AI provider returned an error.', 0, ev.error || {});
      e.partial = result.content;
      throw e;
    }
    if (ev.type === 'ping') return; // keep-alive while the server picks a provider
    if (ev.type === 'start') Object.assign(result, { provider: ev.provider, model: ev.model, mode: ev.mode, rerouted: ev.rerouted });
    if (ev.type === 'delta') result.content += ev.text;
    if (ev.type === 'done') Object.assign(result, { usage: ev.usage, stopReason: ev.stopReason, quota: ev.quota });
    onEvent(ev);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  }
  buffer += decoder.decode();
  handleLine(buffer);
  return result;
}

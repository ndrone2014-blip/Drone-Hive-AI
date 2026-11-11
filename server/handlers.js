import { getServerConfig } from './config.js';
import { getStatus, openChat } from './ai/service.js';
import { enforceAuth, publicAuthStatus } from './auth.js';
import { AIError, ERROR_CODES, toAIError } from './ai/errors.js';
import {
  API_SECURITY_HEADERS,
  clientKey,
  enforceAccessCode,
  enforceRateLimits,
  enforceSameOrigin,
  recordTokenUsage,
  remainingDailyTokens,
} from './security.js';

/**
 * HTTP handlers built on the web-standard Request/Response API, so the exact
 * same code runs on Netlify Edge Functions and in the local Node dev server.
 *
 * `info.ip` is the visitor's IP address (Netlify passes it in context.ip).
 */

const MAX_BODY_BYTES = 512 * 1024;
const JSON_HEADERS = { ...API_SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function errorResponse(err) {
  const e = toAIError(err);
  if (e.details) console.warn(`[drone-hive-ai] ${e.code}: ${String(e.details).slice(0, 300)}`);
  return json({ error: e.toJSON() }, e.status || 500, e.headers || {});
}

async function readBody(req) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request is too large.', 413);
  if (!(req.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request body must be JSON.', 415);
  }
  // Read with a hard cap even if content-length lies or is missing.
  const reader = req.body?.getReader();
  if (!reader) throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request body must be JSON.', 400);
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request is too large.', 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request body must be JSON.', 400);
  }
}

/** GET /api/status */
export async function handleStatusRequest(req) {
  if (req.method !== 'GET') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405, { allow: 'GET' });
  try {
    return json({ ...getStatus(), auth: publicAuthStatus() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/chat  — streams NDJSON events, or returns JSON when stream:false */
export async function handleChatRequest(req, info = {}) {
  if (req.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405, { allow: 'POST' });

  const ipKey = `ip:${clientKey(req, info)}`;
  // Who the limits apply to: the signed-in account when sign-in is on,
  // otherwise the IP address. With accounts, the IP also gets a (3x larger)
  // limit so one person can't multiply their allowance with extra accounts.
  let keys = [{ key: ipKey, scale: 1 }];
  let body;
  let chat;
  try {
    enforceSameOrigin(req);
    const user = await enforceAuth(req);
    if (user) keys = [{ key: `user:${user.uid}`, scale: 1 }, { key: ipKey, scale: 3 }];
    await enforceAccessCode(req, ipKey, getServerConfig().accessCode);
    for (const k of keys) enforceRateLimits(k.key, Date.now(), k.scale);
    body = await readBody(req);
    const budget = Math.min(...keys.map((k) => remainingDailyTokens(k.key, Date.now(), k.scale)));
    chat = await openChat(body, { signal: req.signal, budget });
  } catch (err) {
    return errorResponse(err);
  }

  // Count tokens against this visitor's daily allowance. Uses the provider's
  // real numbers when given, otherwise an estimate from the text.
  let outputChars = 0;
  let counted = false;
  const countUsage = (usage) => {
    if (counted) return;
    counted = true;
    const input = Number(usage?.inputTokens) || chat.inputTokensEstimate;
    const output = Number(usage?.outputTokens) || Math.ceil(outputChars / 4);
    for (const k of keys) recordTokenUsage(k.key, input + output);
  };
  const track = (ev) => {
    if (ev?.type === 'delta') outputChars += String(ev.text || '').length;
    if (ev?.type === 'done') countUsage(ev.usage);
  };

  const meta = { provider: chat.provider, model: chat.model };

  // Non-streaming mode: collect everything, return one JSON response.
  if (body.stream === false) {
    try {
      let content = '';
      let done = {};
      for await (const ev of chat.events) {
        track(ev);
        if (ev.type === 'delta') content += ev.text;
        else if (ev.type === 'done') done = ev;
      }
      return json({ ...meta, message: { role: 'assistant', content }, stopReason: done.stopReason || null, usage: done.usage || {} });
    } catch (err) {
      countUsage();
      return errorResponse(err);
    }
  }

  // Streaming mode: one JSON object per line (NDJSON).
  const encoder = new TextEncoder();
  const iterator = chat.events[Symbol.asyncIterator]();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'start', ...meta }) + '\n'));
    },
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          countUsage();
          controller.close();
          return;
        }
        track(value);
        controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
      } catch (err) {
        countUsage();
        const e = toAIError(err);
        if (e.details) console.warn(`[drone-hive-ai] ${e.code}: ${String(e.details).slice(0, 300)}`);
        if (e.code !== ERROR_CODES.ABORTED) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: e.toJSON() }) + '\n'));
        }
        controller.close();
      }
    },
    async cancel() {
      countUsage();
      try {
        await iterator.return?.();
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...API_SECURITY_HEADERS, 'content-type': 'application/x-ndjson; charset=utf-8' },
  });
}

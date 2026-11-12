import { getServerConfig } from './config.js';
import { getStatus, prepareChat, startChat } from './ai/service.js';
import { enforceAuth, publicAuthStatus } from './auth.js';
import { AIError, ERROR_CODES, toAIError, redact } from './ai/errors.js';
import { beginUsage } from './usage/limits.js';
import { API_SECURITY_HEADERS, clientKey, enforceAccessCode, enforceSameOrigin } from './security.js';

/**
 * HTTP handlers built on the web-standard Request/Response API, so the exact
 * same code runs on Netlify Edge Functions and in the local Node dev server.
 *
 * `info.ip` is the visitor's IP address (Netlify passes it in context.ip).
 */

// Text-only chats are small; this leaves room for up to 4 compressed images.
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PING_MS = 8000;
const JSON_HEADERS = { ...API_SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function logError(e) {
  if (e.details) console.warn(`[drone-hive-ai] ${e.code}: ${redact(String(e.details).slice(0, 400)).slice(0, 300)}`);
}

function errorResponse(err) {
  const e = toAIError(err);
  logError(e);
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

/** Short fingerprint of the newest user message, to refuse duplicate submissions. */
async function fingerprint(prep, mode) {
  const last = prep.messages[prep.messages.length - 1];
  const src = `${mode}|${prep.messages.length}|${last.content}|${(last.images || []).map((i) => i.bytes).join(',')}`;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src));
  return [...new Uint8Array(d).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

/** POST /api/chat — streams NDJSON events, or returns JSON when stream:false */
export async function handleChatRequest(req, info = {}) {
  if (req.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405, { allow: 'POST' });

  const ipKey = `ip:${clientKey(req, info)}`;
  // Who the limits apply to: the signed-in account when sign-in is on,
  // otherwise the IP address. With accounts, the IP also gets a (3x larger)
  // limit so one person can't multiply their allowance with extra accounts.
  let keys = [{ key: ipKey, scale: 1 }];
  let body;
  let prep;
  let ticket;
  try {
    enforceSameOrigin(req);
    const user = await enforceAuth(req);
    if (user) keys = [{ key: `user:${user.uid}`, scale: 1 }, { key: ipKey, scale: 3 }];
    await enforceAccessCode(req, ipKey, getServerConfig().accessCode);
    body = await readBody(req);
    // Validate first, so broken requests never count against anyone's usage.
    prep = prepareChat(body);
    ticket = await beginUsage(keys, { fingerprint: await fingerprint(prep, prep.plan.mode) });
    if (ticket.budget < 64) {
      await ticket.finish(0);
      throw new AIError(ERROR_CODES.USAGE_LIMIT, 'You’ve used today’s AI allowance. Your usage resets every day at midnight UTC.', 429).with({ resetAt: ticket.quota.resetAt });
    }
    prep.maxTokens = Math.max(64, Math.min(prep.maxTokens, ticket.budget));
  } catch (err) {
    return errorResponse(err);
  }

  // Token accounting: the provider's real numbers when given, else an estimate.
  let outputChars = 0;
  let reported = null;
  const tokensUsed = (answered) => {
    if (!answered) return 0;
    const input = Number(reported?.inputTokens) || prep.inputTokensEstimate;
    const output = Number(reported?.outputTokens) || Math.ceil(outputChars / 4);
    return input + output;
  };

  const abort = new AbortController();
  const signal = req.signal ? AbortSignal.any?.([req.signal, abort.signal]) || abort.signal : abort.signal;

  // ── Non-streaming mode: collect everything, return one JSON response. ──
  if (body.stream === false) {
    let chat;
    try {
      chat = await startChat(prep, { signal });
      let content = '';
      let done = {};
      for await (const ev of chat.events) {
        if (ev.type === 'delta') {
          content += ev.text;
          outputChars += ev.text.length;
        } else if (ev.type === 'done') {
          done = ev;
          reported = ev.usage;
        }
      }
      await ticket.finish(tokensUsed(true));
      return json({
        provider: chat.provider,
        model: chat.model,
        mode: chat.mode,
        rerouted: chat.rerouted,
        message: { role: 'assistant', content },
        stopReason: done.stopReason || null,
        usage: done.usage || {},
        quota: ticket.quota,
      });
    } catch (err) {
      const refund = !chat && toAIError(err).code !== ERROR_CODES.ABORTED;
      await ticket.finish(tokensUsed(!refund), { refund });
      return errorResponse(err);
    }
  }

  // ── Streaming mode: one JSON object per line (NDJSON). ──
  // The response starts right away (Netlify needs headers within 40s), then
  // the router tries providers while small "ping" lines keep it alive.
  const encoder = new TextEncoder();
  let iterator = null;
  let answered = false;
  let closed = false;
  let ping = null;
  // Refund the message only if every provider genuinely failed — never when the
  // user cancels (that could otherwise be used to dodge the limits).
  const finishOnce = (refund = false) => ticket.finish(tokensUsed(answered || !refund), { refund });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        if (!closed) controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      };
      send({ type: 'routing', mode: prep.plan.mode });
      ping = setInterval(() => {
        try {
          send({ type: 'ping' });
        } catch {
          /* stream closed */
        }
      }, PING_MS);
      try {
        const chat = await startChat(prep, { signal });
        iterator = chat.events[Symbol.asyncIterator]();
        answered = true;
        send({ type: 'start', provider: chat.provider, model: chat.model, mode: chat.mode, rerouted: chat.rerouted });
      } catch (err) {
        const e = toAIError(err);
        logError(e);
        if (e.code !== ERROR_CODES.ABORTED) send({ type: 'error', error: e.toJSON() });
        await finishOnce(e.code !== ERROR_CODES.ABORTED);
        closed = true;
        controller.close();
      } finally {
        clearInterval(ping);
      }
    },
    async pull(controller) {
      if (closed) return;
      try {
        const { value, done } = await iterator.next();
        if (done) {
          await finishOnce();
          closed = true;
          controller.close();
          return;
        }
        if (value.type === 'delta') outputChars += String(value.text || '').length;
        if (value.type === 'done') {
          reported = value.usage;
          await finishOnce();
          controller.enqueue(encoder.encode(JSON.stringify({ ...value, quota: ticket.quota }) + '\n'));
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
      } catch (err) {
        await finishOnce();
        const e = toAIError(err);
        logError(e);
        if (e.code !== ERROR_CODES.ABORTED && !closed) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: e.toJSON() }) + '\n'));
        }
        closed = true;
        controller.close();
      }
    },
    async cancel() {
      closed = true;
      clearInterval(ping);
      abort.abort();
      await finishOnce();
      try {
        await iterator?.return?.();
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

import { getServerConfig } from './config.js';
import { getStatus, openChat } from './ai/service.js';
import { AIError, ERROR_CODES, toAIError } from './ai/errors.js';

/**
 * HTTP handlers built on the web-standard Request/Response API, so the exact
 * same code runs on Netlify Edge Functions and in the local Node dev server.
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorResponse(err) {
  const e = toAIError(err);
  return json({ error: e.toJSON() }, e.status || 500);
}

function checkAccess(req) {
  const { accessCode } = getServerConfig();
  if (!accessCode) return;
  const sent = req.headers.get('x-dronehive-access') || '';
  if (sent !== accessCode) {
    throw new AIError(ERROR_CODES.UNAUTHORIZED, 'This Drone Hive AI server requires an access code. Enter it in Settings → AI Configuration.', 401);
  }
}

/** GET /api/status */
export async function handleStatusRequest(req) {
  if (req.method !== 'GET') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405);
  try {
    return json(getStatus());
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/chat  — streams NDJSON events, or returns JSON when stream:false */
export async function handleChatRequest(req) {
  if (req.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405);

  let body;
  try {
    checkAccess(req);
    const text = await req.text();
    if (text.length > 1_000_000) throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request is too large.', 413);
    try {
      body = JSON.parse(text);
    } catch {
      throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request body must be JSON.', 400);
    }
  } catch (err) {
    return errorResponse(err);
  }

  let chat;
  try {
    chat = await openChat(body, { signal: req.signal });
  } catch (err) {
    return errorResponse(err);
  }

  const meta = { provider: chat.provider, model: chat.model };

  // Non-streaming mode: collect everything, return one JSON response.
  if (body.stream === false) {
    try {
      let content = '';
      let done = {};
      for await (const ev of chat.events) {
        if (ev.type === 'delta') content += ev.text;
        else if (ev.type === 'done') done = ev;
      }
      return json({ ...meta, message: { role: 'assistant', content }, stopReason: done.stopReason || null, usage: done.usage || {} });
    } catch (err) {
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
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
      } catch (err) {
        const e = toAIError(err);
        if (e.code !== ERROR_CODES.ABORTED) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: e.toJSON() }) + '\n'));
        }
        controller.close();
      }
    },
    async cancel() {
      try {
        await iterator.return?.();
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

import { getServerConfig } from './config.js';
import { getStatus, prepareChat, startChat } from './ai/service.js';
import { enforceAuth, publicAuthStatus } from './auth.js';
import { AIError, ERROR_CODES, toAIError, redact } from './ai/errors.js';
import { beginUsage } from './usage/limits.js';
import { API_SECURITY_HEADERS, clientKey, enforceAccessCode, enforceSameOrigin } from './security.js';
import { loadMemories, memoryStoreMode, updateMemories } from './memory/store.js';
import { parseMemoryRequest, resolveMemoryOps } from './memory/prompt.js';
import { MEMORY_LIMITS } from '../public/js/shared/memory-rules.js';

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

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Request is too large.', 413);
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
    if (size > maxBytes) {
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
  let user = null;
  try {
    enforceSameOrigin(req);
    user = await enforceAuth(req);
    if (user) keys = [{ key: `user:${user.uid}`, scale: 1 }, { key: ipKey, scale: 3 }];
    await enforceAccessCode(req, ipKey, getServerConfig().accessCode);
    body = await readBody(req);
    // Validate first, so broken requests never count against anyone's usage.
    prep = prepareChat(body, { memory: await loadChatMemory(body.memory, user) });
    ticket = await beginUsage(keys, { fingerprint: await fingerprint(prep, prep.plan.mode) });
    // The request's input counts too, so the reply may only use what's left
    // after it. This keeps the daily, weekly and monthly totals exact.
    const outputRoom = ticket.budget - prep.inputTokensEstimate;
    if (outputRoom < 64) {
      await ticket.finish(0, { refund: true });
      const when = { day: 'Your usage resets every day at midnight UTC.', week: 'Your weekly allowance resets every Monday at midnight UTC.', month: 'Your monthly allowance resets on the 1st at midnight UTC.' }[ticket.budgetPeriod];
      const msg = ticket.budget < 64
        ? `You’ve used your ${ticket.budgetPeriod === 'day' ? 'daily' : `${ticket.budgetPeriod}ly`} AI allowance. ${when}`
        : `There isn’t enough of your ${ticket.budgetPeriod === 'day' ? 'daily' : `${ticket.budgetPeriod}ly`} AI allowance left for this message (about ${ticket.budget.toLocaleString('en-US')} tokens left). Start a new chat to send less history, or wait for the reset. ${when}`;
      throw new AIError(ERROR_CODES.USAGE_LIMIT, msg, 429, undefined, {
        'retry-after': String(Math.max(1, Math.ceil((Date.parse(ticket.budgetResetAt) - Date.now()) / 1000))),
      }).with({ resetAt: ticket.budgetResetAt });
    }
    prep.maxTokens = Math.max(64, Math.min(prep.maxTokens, outputRoom));
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
      let memory = null;
      let memoryHandled = false;
      for await (const ev of chat.events) {
        if (ev.type === 'delta') {
          content += ev.text;
          outputChars += ev.text.length;
        } else if (ev.type === 'memory_ops') {
          memoryHandled = true;
          memory = await saveChatMemory(prep, user, ev.ops);
        } else if (ev.type === 'done') {
          done = ev;
          reported = ev.usage;
        }
      }
      if (!memoryHandled) memory = await saveChatMemory(prep, user, []);
      await ticket.finish(tokensUsed(true));
      return json({
        ...(memory ? { memory } : {}),
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
  let memoryHandled = false;
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
      // Keep reading until something is sent: a pull that sends nothing could
      // leave the stream waiting forever.
      while (!closed) {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            if (!memoryHandled) {
              memoryHandled = true;
              const mem = await saveChatMemory(prep, user, []);
              if (mem) controller.enqueue(encoder.encode(JSON.stringify(mem) + '\n'));
            }
            await finishOnce();
            closed = true;
            controller.close();
            return;
          }
          if (value.type === 'memory_ops') {
            memoryHandled = true;
            const mem = await saveChatMemory(prep, user, value.ops);
            if (!mem) continue;
            controller.enqueue(encoder.encode(JSON.stringify(mem) + '\n'));
            return;
          }
          if (value.type === 'delta') outputChars += String(value.text || '').length;
          if (value.type === 'done') {
            reported = value.usage;
            if (!memoryHandled) {
              memoryHandled = true;
              const mem = await saveChatMemory(prep, user, []);
              if (mem) controller.enqueue(encoder.encode(JSON.stringify(mem) + '\n'));
            }
            await finishOnce();
            controller.enqueue(encoder.encode(JSON.stringify({ ...value, quota: ticket.quota }) + '\n'));
            return;
          }
          controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
          return;
        } catch (err) {
          await finishOnce();
          const e = toAIError(err);
          logError(e);
          if (e.code !== ERROR_CODES.ABORTED && !closed) {
            controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: e.toJSON() }) + '\n'));
          }
          closed = true;
          controller.close();
          return;
        }
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

// ── Memory ───────────────────────────────────────────────────────────────────

/**
 * The memory settings and notes for one chat request.
 *  - account storage: notes are loaded from Firestore for the signed-in user
 *    (anything the browser sent is ignored, so nobody can read or inject
 *    another account's notes);
 *  - browser storage: the browser sends its own notes for this account.
 */
async function loadChatMemory(raw, user) {
  if (!raw || raw.enabled !== true) return { enabled: false };
  const store = memoryStoreMode() === 'account' && user ? 'account' : 'browser';
  let serverItems = null;
  let loadFailed = false;
  if (store === 'account') {
    try {
      serverItems = await loadMemories(user.uid);
    } catch (err) {
      console.warn(`[drone-hive-ai] memory load failed: ${redact(String(err?.message || err)).slice(0, 200)}`);
      serverItems = [];
      loadFailed = true;
    }
  }
  return { ...parseMemoryRequest(raw, { serverItems }), store, uid: user?.uid || null, loadFailed };
}

/**
 * Applies what the AI asked to remember. Returns the `memory` event for the
 * browser, or null when nothing changed.
 */
async function saveChatMemory(prep, user, ops) {
  const memory = prep.memory;
  if (!memory?.enabled) return null;
  const all = resolveMemoryOps(ops, { idMap: prep.memoryIds, memory, lastUserText: prep.lastUserText });
  const blocked = all.filter((o) => o.blocked).map((o) => ({ op: o.op, reason: o.blocked, sensitive: true }));
  const resolved = all.filter((o) => !o.blocked);
  if (!resolved.length) return blocked.length ? { type: 'memory', store: memory.store, saved: false, applied: [], rejected: blocked } : null;
  if (memory.store === 'account') {
    if (memory.loadFailed) return { type: 'memory', store: 'account', saved: false, error: 'Memory is unavailable right now, so this wasn’t saved.' };
    try {
      const r = await updateMemories(user.uid, resolved);
      return { type: 'memory', store: 'account', saved: true, applied: r.applied, rejected: [...blocked, ...publicRejections(r.rejected)], items: r.items };
    } catch (err) {
      console.warn(`[drone-hive-ai] memory save failed: ${redact(String(err?.message || err)).slice(0, 200)}`);
      return { type: 'memory', store: 'account', saved: false, error: 'Memory is unavailable right now, so this wasn’t saved.' };
    }
  }
  // Browser storage: the browser applies these with the same shared rules.
  return { type: 'memory', store: 'browser', saved: false, ops: resolved, rejected: blocked };
}

const publicRejections = (list) => list.filter((r) => r.sensitive || r.reason === 'full').map((r) => ({ op: r.op, reason: r.reason, ...(r.sensitive ? { sensitive: true } : {}) }));

/**
 * /api/memory — view and manage the signed-in account's memories (account
 * storage only; with browser storage the browser manages them itself).
 *   GET                         → { store, items }
 *   POST   { text, category }   → add one
 *   POST   { import: [items] }  → copy notes saved in this browser into the account
 *   PATCH  { id, text?, category? }
 *   DELETE ?id=…                → delete one
 *   DELETE ?all=1               → delete all
 */
export async function handleMemoryRequest(req) {
  const allowed = ['GET', 'POST', 'PATCH', 'DELETE'];
  if (!allowed.includes(req.method)) return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, 405, { allow: allowed.join(', ') });
  try {
    enforceSameOrigin(req);
    const user = await enforceAuth(req);
    if (memoryStoreMode() !== 'account' || !user) {
      throw new AIError(ERROR_CODES.MEMORY_IN_BROWSER, 'On this server, memories are saved in your browser rather than in your account.', 409);
    }
    const url = new URL(req.url);
    let ops;
    let body = null;
    if (req.method === 'GET') {
      return json({ store: 'account', items: await withMemoryErrors(() => loadMemories(user.uid)), limits: MEMORY_LIMITS });
    }
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (url.searchParams.get('all') === '1') ops = [{ op: 'clear' }];
      else if (id) ops = [{ op: 'delete', id: id.slice(0, 64) }];
      else throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Say which memory to delete.', 400);
    } else {
      body = await readBody(req, 64 * 1024);
      if (req.method === 'POST' && Array.isArray(body.import)) {
        ops = body.import.slice(0, MEMORY_LIMITS.maxItems).map((m) => ({ op: 'add', text: m?.text, category: m?.category, source: m?.source === 'chat' ? 'chat' : 'manual' }));
      } else if (req.method === 'POST') {
        ops = [{ op: 'add', text: body.text, category: body.category, source: 'manual' }];
      } else {
        if (typeof body.id !== 'string') throw new AIError(ERROR_CODES.INVALID_REQUEST, 'Say which memory to change.', 400);
        ops = [{ op: 'update', id: body.id.slice(0, 64), ...(body.text !== undefined ? { text: body.text } : {}), ...(body.category !== undefined ? { category: body.category } : {}) }];
      }
    }
    const isImport = req.method === 'POST' && Array.isArray(body?.import);
    const r = await withMemoryErrors(() => updateMemories(user.uid, ops));
    // Deleting something that's already gone counts as done; an import reports
    // what was skipped instead of failing.
    const alreadyGone = ops[0]?.op === 'delete' && r.rejected[0]?.reason === 'not found';
    if (!r.applied.length && r.rejected.length && !isImport && !alreadyGone) {
      throw new AIError(ERROR_CODES.MEMORY_REJECTED, rejectionMessage(r.rejected[0]), 400);
    }
    return json({ store: 'account', items: r.items, applied: r.applied, rejected: publicRejections(r.rejected) });
  } catch (err) {
    return errorResponse(err);
  }
}

async function withMemoryErrors(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw new AIError(ERROR_CODES.MEMORY_UNAVAILABLE, 'Memory is temporarily unavailable. Please try again in a moment.', 503, String(err?.message || err));
  }
}

function rejectionMessage(r) {
  if (r?.sensitive) return `This wasn’t saved because ${r.reason}. Drone Hive AI never stores passwords, keys or other secrets.`;
  if (r?.reason === 'duplicate') return 'That’s already saved.';
  if (r?.reason === 'full') return `You’ve reached the limit of ${MEMORY_LIMITS.maxItems} memories. Delete some to add more.`;
  if (r?.reason === 'not found') return 'That memory no longer exists. It may have been deleted on another device.';
  return 'Write something to remember.';
}

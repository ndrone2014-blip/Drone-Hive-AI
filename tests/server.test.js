/**
 * Backend tests — run with:  npm test
 * These use a fake provider stream (stubbed fetch) so no API key or network
 * is needed. Nothing here is used by the real app.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatRequest, handleStatusRequest } from '../server/handlers.js';
import { normalizeMessages } from '../server/ai/messages.js';
import { parseSSE } from '../server/ai/sse.js';
import { _resetSecurityState } from '../server/security.js';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_MODELS', 'OPENAI_COMPAT_API_KEY', 'OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_MODEL', 'DRONEHIVE_ACCESS_CODE', 'AI_PROVIDER', 'OLLAMA_API_KEY', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'OLLAMA_MODELS', 'NETLIFY_AI_GATEWAY_KEY', 'NETLIFY_AI_GATEWAY_BASE_URL', 'ANTHROPIC_BASE_URL', 'ALLOW_NETLIFY_AI_GATEWAY'];
const realFetch = globalThis.fetch;
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  _resetSecurityState();
});
afterEach(() => {
  ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  globalThis.fetch = realFetch;
});

const chatReq = (body, headers = {}) =>
  new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

function sseBody(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new TextEncoder().encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function readNDJSON(res) {
  const text = await res.text();
  return text.trim().split('\n').map((l) => JSON.parse(l));
}

test('status reports disconnected with no keys and never leaks secrets', async () => {
  const res = await handleStatusRequest(new Request('http://local/api/status'));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.connected, false);
  assert.equal(data.activeProvider, null);
  assert.ok(data.providers.length >= 2);

  process.env.ANTHROPIC_API_KEY = 'sk-secret-value';
  const res2 = await handleStatusRequest(new Request('http://local/api/status'));
  const raw = await res2.text();
  assert.ok(!raw.includes('sk-secret-value'), 'API key must never appear in status');
  assert.equal(JSON.parse(raw).connected, true);
});

test('chat returns PROVIDER_NOT_CONFIGURED (503) when no key is set', async () => {
  const res = await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'PROVIDER_NOT_CONFIGURED');
});

test('chat rejects non-POST, bad JSON and empty messages', async () => {
  assert.equal((await handleChatRequest(new Request('http://local/api/chat'))).status, 405);
  process.env.ANTHROPIC_API_KEY = 'k';
  const bad = await handleChatRequest(new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' }));
  assert.equal(bad.status, 400);
  const notJson = await handleChatRequest(new Request('http://local/api/chat', { method: 'POST', body: '{}' }));
  assert.equal(notJson.status, 415);
  const empty = await handleChatRequest(chatReq({ messages: [] }));
  assert.equal((await empty.json()).error.code, 'INVALID_REQUEST');
});

test('anthropic provider streams deltas as NDJSON and sends the right request', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return sseBody([
      { type: 'message_start', message: { usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
  };
  const res = await handleChatRequest(
    chatReq({
      model: 'not-allowed-model',
      messages: [
        { role: 'assistant', content: 'leading assistant is dropped' },
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ],
      options: { temperature: 5, customInstructions: 'Be brief.' },
    }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /ndjson/);
  const events = await readNDJSON(res);
  assert.equal(events[0].type, 'start');
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Hello there');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).stopReason, 'end_turn');

  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['x-api-key'], 'test-key');
  assert.equal(sent.body.model, 'claude-sonnet-5-5', 'unknown models fall back to the default');
  assert.equal(sent.body.temperature, 1, 'temperature is clamped');
  assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'one\n\ntwo' }]);
  assert.match(sent.body.system, /Be brief\./);
});

test('non-streaming mode returns a single JSON message', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async () => sseBody([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi!' } }]);
  const res = await handleChatRequest(chatReq({ stream: false, messages: [{ role: 'user', content: 'hey' }] }));
  const data = await res.json();
  assert.equal(data.message.content, 'Hi!');
});

test('provider auth errors map to PROVIDER_AUTH without leaking the key', async () => {
  process.env.ANTHROPIC_API_KEY = 'bad-key';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 });
  const res = await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'hey' }] }));
  const body = await res.text();
  assert.equal(JSON.parse(body).error.code, 'PROVIDER_AUTH');
  assert.ok(!body.includes('bad-key'));
});

test('access code is enforced when configured', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.DRONEHIVE_ACCESS_CODE = 'hive123';
  globalThis.fetch = async () => sseBody([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }]);
  const denied = await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'x' }] }));
  assert.equal(denied.status, 401);
  const ok = await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'x' }] }, { 'x-dronehive-access': 'hive123' }));
  assert.equal(ok.status, 200);
});

test('openai-compatible provider streams chat completions format', async () => {
  process.env.OPENAI_COMPAT_API_KEY = 'k';
  process.env.OPENAI_COMPAT_BASE_URL = 'https://example.test/v1/';
  process.env.OPENAI_COMPAT_MODEL = 'some-model';
  let url;
  globalThis.fetch = async (u) => {
    url = u;
    const lines = ['{"choices":[{"delta":{"content":"Yo"}}]}', '{"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}', '[DONE]'];
    return new Response(lines.map((l) => `data: ${l}\n\n`).join(''), { status: 200 });
  };
  const res = await handleChatRequest(chatReq({ provider: 'openai-compatible', messages: [{ role: 'user', content: 'hi' }] }));
  const events = await readNDJSON(res);
  assert.equal(url, 'https://example.test/v1/chat/completions');
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Yo!');
});

test('ollama provider uses Ollama Cloud with only OLLAMA_API_KEY set', async () => {
  process.env.OLLAMA_API_KEY = 'ollama-key';
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response('data: {"choices":[{"delta":{"content":"Buzz"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
  };
  const status = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  assert.equal(status.activeProvider, 'ollama');
  const res = await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'hi' }] }));
  const events = await readNDJSON(res);
  assert.equal(sent.url, 'https://ollama.com/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, 'Bearer ollama-key');
  assert.equal(sent.body.model, 'gpt-oss:120b');
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Buzz');
});

test('Netlify AI Gateway (auto-injected Claude) is blocked so it never spends Netlify credits', async () => {
  process.env.NETLIFY_AI_GATEWAY_KEY = 'gw-key';
  process.env.NETLIFY_AI_GATEWAY_BASE_URL = 'https://gateway.netlify.test';
  process.env.ANTHROPIC_API_KEY = 'gw-placeholder';
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.netlify.test/anthropic';
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('', { status: 500 }); };
  const status = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  assert.equal(status.providers.find((p) => p.id === 'anthropic').configured, false);
  assert.equal(status.connected, false);
  const res = await handleChatRequest(chatReq({ provider: 'anthropic', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(res.status, 503);
  assert.equal(called, false, 'no request may reach the gateway');

  process.env.ALLOW_NETLIFY_AI_GATEWAY = 'true';
  const status2 = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  assert.equal(status2.activeProvider, 'anthropic', 'gateway works only when explicitly allowed');
});

test('normalizeMessages enforces limits', () => {
  const limits = { maxMessages: 100, maxMessageChars: 10, maxTotalChars: 1000 };
  assert.throws(() => normalizeMessages([{ role: 'user', content: 'x'.repeat(11) }], limits), /too long/);
  assert.throws(() => normalizeMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], limits), /last message/);
});

test('parseSSE handles CRLF and split chunks', async () => {
  const enc = new TextEncoder();
  const parts = ['event: a\r\ndata: {"x"', ':1}\r\n\r\ndata: two\n\n'];
  const body = new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(enc.encode(p))); c.close(); } });
  const out = [];
  for await (const e of parseSSE(body)) out.push(e);
  assert.deepEqual(out, [{ event: 'a', data: '{"x":1}' }, { event: 'message', data: 'two' }]);
});

// ── Security / abuse protection ─────────────────────────────────────────────
const okStream = () => sseBody([{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }]);
const msg = (content = 'hi') => ({ messages: [{ role: 'user', content }] });

test('per-visitor rate limit returns 429 with retry-after', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.AI_RATE_LIMIT_PER_MINUTE = '3';
  globalThis.fetch = async () => okStream();
  try {
    for (let i = 0; i < 3; i++) {
      const r = await handleChatRequest(chatReq(msg()), { ip: '1.1.1.1' });
      assert.equal(r.status, 200);
      await r.text();
    }
    const blocked = await handleChatRequest(chatReq(msg()), { ip: '1.1.1.1' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    // A different visitor is unaffected
    assert.equal((await handleChatRequest(chatReq(msg()), { ip: '2.2.2.2' })).status, 200);
  } finally {
    delete process.env.AI_RATE_LIMIT_PER_MINUTE;
  }
});

test('daily token budget blocks a visitor once used up', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.AI_DAILY_TOKENS_PER_USER = '1000';
  globalThis.fetch = async () =>
    sseBody([
      { type: 'message_start', message: { usage: { input_tokens: 600 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } },
    ]);
  try {
    const first = await handleChatRequest(chatReq(msg()), { ip: '3.3.3.3' });
    assert.equal(first.status, 200);
    await first.text();
    const second = await handleChatRequest(chatReq(msg()), { ip: '3.3.3.3' });
    assert.equal(second.status, 429);
    assert.match((await second.json()).error.message, /token limit/i);
  } finally {
    delete process.env.AI_DAILY_TOKENS_PER_USER;
  }
});

test('access code locks out after repeated wrong guesses', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.DRONEHIVE_ACCESS_CODE = 'right-code';
  globalThis.fetch = async () => okStream();
  for (let i = 0; i < 5; i++) {
    const r = await handleChatRequest(chatReq(msg(), { 'x-dronehive-access': 'wrong' }), { ip: '4.4.4.4' });
    assert.equal(r.status, 401);
  }
  // Even the right code is refused during the lockout
  const locked = await handleChatRequest(chatReq(msg(), { 'x-dronehive-access': 'right-code' }), { ip: '4.4.4.4' });
  assert.equal(locked.status, 429);
});

test('requests from other websites are blocked', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  globalThis.fetch = async () => okStream();
  const evil = await handleChatRequest(chatReq(msg(), { origin: 'https://evil.example' }));
  assert.equal(evil.status, 403);
  const crossSite = await handleChatRequest(chatReq(msg(), { 'sec-fetch-site': 'cross-site' }));
  assert.equal(crossSite.status, 403);
  const own = await handleChatRequest(chatReq(msg(), { origin: 'http://local' }));
  assert.equal(own.status, 200);
});

test('output tokens are capped and huge inputs are trimmed or rejected', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  let sent;
  globalThis.fetch = async (_u, init) => {
    sent = JSON.parse(init.body);
    return okStream();
  };
  const r = await handleChatRequest(chatReq({ ...msg(), options: { maxTokens: 999999 } }));
  await r.text();
  assert.equal(sent.max_tokens, 2048);

  // Long history: oldest messages are dropped to fit the input budget
  const history = [];
  for (let i = 0; i < 15; i++) history.push({ role: 'user', content: 'u'.repeat(8000) }, { role: 'assistant', content: 'a'.repeat(8000) });
  history.push({ role: 'user', content: 'latest question' });
  const r2 = await handleChatRequest(chatReq({ messages: history }));
  assert.equal(r2.status, 200);
  await r2.text();
  const chars = sent.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars <= 12000 * 4, `sent ${chars} chars`);
  assert.match(sent.messages.at(-1).content, /latest question/);
});

test('oversized request bodies are rejected', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  const big = await handleChatRequest(chatReq(msg('x'.repeat(600 * 1024))));
  assert.equal(big.status, 413);
});

test('provider error details are never sent to the browser', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'internal-trace-xyz' } }), { status: 500 });
  const res = await handleChatRequest(chatReq(msg()));
  const body = await res.json();
  assert.equal(body.error.details, undefined);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('access code ignores accidental spaces', async () => {
  process.env.ANTHROPIC_API_KEY = 'k';
  process.env.DRONEHIVE_ACCESS_CODE = 'hive123';
  globalThis.fetch = async () => okStream();
  const r = await handleChatRequest(chatReq(msg(), { 'x-dronehive-access': '  hive123 ' }));
  assert.equal(r.status, 200);
});

test('provider 402 (free usage used up) gets a clear message', async () => {
  process.env.OLLAMA_API_KEY = 'k';
  globalThis.fetch = async () => new Response('{"error":"usage limit"}', { status: 402 });
  const res = await handleChatRequest(chatReq(msg()));
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.match(body.error.message, /used up its free usage/);
});

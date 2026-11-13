/**
 * Tests for Drone Hive AI 0.4: the Google Gemini fix, Vibe AI (Mistral AI),
 * Automatic as the standard mode, and the new usage limits.
 * Run with: npm test   (no network or API keys needed — fetch is stubbed)
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatRequest, handleStatusRequest } from '../server/handlers.js';
import { _resetSecurityState } from '../server/security.js';
import { _resetAuthKeys } from '../server/auth.js';
import { _resetUsageState, beginUsage, getLimitConfig } from '../server/usage/limits.js';
import { _resetFirestoreToken } from '../server/usage/firestore.js';
import { _resetRouterState, planRoute, parseMode } from '../server/ai/router.js';
import { errorFromProviderResponse } from '../server/ai/errors.js';
import { cleanKey } from '../server/ai/providers/keys.js';
import { PROVIDERS } from '../server/ai/providers/index.js';

const realFetch = globalThis.fetch;
const saved = { ...process.env };
const ENV_RE = /^(GEMINI|GOOGLE_|MISTRAL|OPENAI_COMPAT|OPENROUTER|GROQ|OLLAMA|ANTHROPIC|AI_|FIREBASE|USAGE_STORE|NETLIFY|DRONEHIVE|AUTH_REQUIRED|ALLOW_)/;
const setEnv = (vars) => {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (ENV_RE.test(k)) delete process.env[k];
  _resetSecurityState();
  _resetAuthKeys();
  _resetUsageState();
  _resetRouterState();
  _resetFirestoreToken();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (ENV_RE.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) if (ENV_RE.test(k)) process.env[k] = v;
});

const chatReq = (body, headers = {}) =>
  new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const readNDJSON = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
const sse = (...texts) => new Response(texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
const text = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const status = async () => (await handleStatusRequest(new Request('http://local/api/status'))).json();
const host = (url) => new URL(url).hostname;
const PROVIDER_OF = { 'generativelanguage.googleapis.com': 'gemini', 'api.mistral.ai': 'mistral', 'openrouter.ai': 'openrouter', 'api.groq.com': 'groq', 'ollama.com': 'ollama' };
const msg = (content) => [{ role: 'user', content }];

// ── 1. Google Gemini ─────────────────────────────────────────────────────────
test('Gemini: a Netlify AI Gateway placeholder key is never sent to Google (the root cause)', async () => {
  // What Netlify injects when you haven't set your own key.
  setEnv({ GEMINI_API_KEY: 'nf-gateway-token', GOOGLE_GEMINI_BASE_URL: 'https://dronehiveai.netlify.app/.netlify/ai/gemini', NETLIFY_AI_GATEWAY_KEY: 'nf-gateway-token', GROQ_API_KEY: 'gsk_x' });
  const calls = [];
  globalThis.fetch = async (url) => (calls.push(host(url)), sse('hi from groq'));
  const st = await status();
  const gem = st.providers.find((p) => p.id === 'gemini');
  assert.equal(gem.configured, false);
  assert.equal(gem.issue, 'gateway-placeholder', 'Settings can explain why');
  assert.ok(!JSON.stringify(st).includes('nf-gateway-token'));
  const events = await readNDJSON(await handleChatRequest(chatReq({ messages: msg('hello') })));
  assert.deepEqual(calls, ['api.groq.com'], 'Google is not called with the placeholder');
  assert.equal(text(events), 'hi from groq');
});

test('Gemini: a real key works — GEMINI_API_KEY or GOOGLE_API_KEY — and sends a correct streaming request', async () => {
  for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    for (const k of Object.keys(process.env)) if (ENV_RE.test(k)) delete process.env[k];
    _resetUsageState();
    // Pasted with quotes and a trailing newline — still works.
    setEnv({ [name]: '"AIzaRealKey123"\n' });
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\ndata: [DONE]\n\n', { status: 200 });
    };
    const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'gemini', messages: msg('hi') })));
    assert.equal(sent.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', name);
    assert.equal(sent.headers.authorization, 'Bearer AIzaRealKey123', `${name}: key cleaned`);
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.stream_options, { include_usage: true }, 'real token counts are requested');
    assert.equal(sent.body.messages[0].role, 'system');
    assert.equal(text(events), 'Hello');
    const done = events.find((e) => e.type === 'done');
    assert.deepEqual(done.usage, { inputTokens: 11, outputTokens: 3 });
    assert.equal(done.quota.tokensUsed, 14, 'provider-reported tokens are what counts');
  }
});

test("Gemini: Google's 400 'Please pass a valid API key' is a key error (skipped at once, cooled down)", async () => {
  const body = '[{\n  "error": {\n    "code": 400,\n    "message": "Please pass a valid API key",\n    "status": "INVALID_ARGUMENT"\n  }\n}\n]';
  const err = await errorFromProviderResponse(new Response(body, { status: 400 }), 'Google Gemini');
  assert.equal(err.code, 'PROVIDER_AUTH');
  assert.equal(err.details, 'Please pass a valid API key', 'array-wrapped error body is parsed');

  setEnv({ GEMINI_API_KEY: 'AIzaWrong', GROQ_API_KEY: 'gsk_x' });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(host(url));
    return host(url).startsWith('generativelanguage') ? new Response(body, { status: 400 }) : sse('ok');
  };
  await (await handleChatRequest(chatReq({ messages: msg('hi') }))).text();
  assert.deepEqual(calls, ['generativelanguage.googleapis.com', 'api.groq.com'], 'only one Gemini attempt with a bad key');
  calls.length = 0;
  await (await handleChatRequest(chatReq({ messages: msg('hi again') }))).text();
  assert.deepEqual(calls, ['api.groq.com'], 'Gemini is on cooldown after a key error');
});

test('Gemini chosen by hand reports a clear error when unavailable', async () => {
  setEnv({ GEMINI_API_KEY: 'AIzaX' });
  globalThis.fetch = async () => new Response('{"error":{"message":"overloaded"}}', { status: 503 });
  const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'gemini', messages: msg('hi') })));
  const err = events.at(-1);
  assert.equal(err.type, 'error');
  assert.equal(err.error.code, 'PROVIDER_UNAVAILABLE');
  assert.match(err.error.message, /Google Gemini is temporarily unavailable/);
  assert.ok(!JSON.stringify(err).includes('overloaded'), 'raw provider text stays on the server');
});

test('cleanKey strips quotes, Bearer and whitespace', () => {
  assert.equal(cleanKey("  'abc 123'\n"), 'abc123');
  assert.equal(cleanKey('Bearer xyz'), 'xyz');
  assert.equal(cleanKey(''), undefined);
});

// ── 2. Vibe AI (Mistral AI) ──────────────────────────────────────────────────
test('Vibe AI (Mistral AI) is ONE provider, streams replies and sends a correct request', async () => {
  setEnv({ MISTRAL_API_KEY: 'mistral-secret-key' });
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(ids.filter((id) => /mistral|vibe/.test(id)).length, 1, 'no duplicate provider entries');
  const st = await status();
  const m = st.providers.find((p) => p.id === 'mistral');
  assert.equal(m.name, 'Vibe AI (Mistral AI)');
  assert.equal(m.shortName, 'Vibe AI');
  assert.equal(m.configured, true);
  assert.equal(m.capabilities.vision, true);
  assert.ok(!JSON.stringify(st).includes('mistral-secret-key'), 'key never reaches the browser');

  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    // Mistral reasoning models stream content as parts; "thinking" must be hidden.
    return new Response(
      'data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"secret plan"}]}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":[{"type":"text","text":"Bonjour"}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      { status: 200 },
    );
  };
  for (const alias of ['mistral', 'vibe']) {
    _resetUsageState();
    const events = await readNDJSON(await handleChatRequest(chatReq({ provider: alias, messages: msg('salut') })));
    assert.equal(sent.url, 'https://api.mistral.ai/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer mistral-secret-key');
    assert.equal(sent.body.model, 'mistral-medium-latest');
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.stream_options, undefined, 'no fields Mistral might reject');
    assert.equal(text(events), 'Bonjour!');
    assert.ok(!JSON.stringify(events).includes('secret plan'), 'thinking is hidden');
    assert.equal(events.find((e) => e.type === 'start').provider.id, 'mistral');
    assert.deepEqual(events.find((e) => e.type === 'done').usage, { inputTokens: 20, outputTokens: 2 });
  }
});

test('Vibe AI sends images in Mistral’s format and handles a bad key', async () => {
  setEnv({ MISTRAL_API_KEY: 'k' });
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let body;
  globalThis.fetch = async (_u, init) => ((body = JSON.parse(init.body)), sse('a cat'));
  await (await handleChatRequest(chatReq({ provider: 'mistral', messages: [{ role: 'user', content: [{ type: 'text', text: 'What is it?' }, { type: 'image', mediaType: 'image/png', data: PNG }] }] }))).text();
  const part = body.messages.at(-1).content.find((p) => p.type === 'image_url');
  assert.equal(part.image_url, `data:image/png;base64,${PNG}`);
  assert.ok(['mistral-medium-latest', 'mistral-small-latest'].includes(body.model), 'an image-capable model');

  globalThis.fetch = async () => new Response('{"message":"Unauthorized"}', { status: 401 });
  const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'mistral', messages: msg('hi') })));
  assert.equal(events.at(-1).error.code, 'PROVIDER_AUTH');
  assert.match(events.at(-1).error.message, /Vibe AI \(Mistral AI\) rejected the API key/);
});

// ── 3. Automatic is the standard mode ────────────────────────────────────────
function everyProvider() {
  setEnv({ GEMINI_API_KEY: 'AIzaG', MISTRAL_API_KEY: 'mk', OPENROUTER_API_KEY: 'sk-or-x', GROQ_API_KEY: 'gsk_x', OLLAMA_API_KEY: 'ok' });
}
const firstPick = (messages, extra = {}) => planRoute({ modeValue: extra.mode, messages, lastProvider: extra.lastProvider }).steps.map((s) => s.provider.id);

test('a request without a mode uses Automatic; "default" still works', () => {
  assert.deepEqual(parseMode(undefined), { mode: 'automatic' });
  assert.deepEqual(parseMode(''), { mode: 'automatic' });
  assert.deepEqual(parseMode('default'), { mode: 'default' });
  assert.deepEqual(parseMode('vibe-ai'), { mode: 'manual', providerId: 'mistral' });
});

test('Automatic picks the provider that suits each kind of question', () => {
  everyProvider();
  const norm = (c) => [{ role: 'user', content: c, images: [] }];
  assert.equal(firstPick(norm('Fix this bug: ```js\nconst x = ;\n```'))[0], 'mistral', 'code → Vibe AI (Codestral)');
  assert.equal(firstPick(norm('Explain step by step why the sky is blue and compare it to sunsets'))[0], 'gemini', 'reasoning → Gemini');
  assert.equal(firstPick(norm('hey there'))[0], 'gemini', 'quick chat → Gemini Flash-Lite');
  const img = [{ role: 'user', content: 'what is this', images: [{ mediaType: 'image/png', data: 'x', bytes: 10 }] }];
  assert.equal(firstPick(img)[0], 'gemini', 'images → Gemini');
  // Every connected provider stays available as backup, each once.
  const all = firstPick(norm('hey'));
  assert.deepEqual([...all].sort(), ['gemini', 'groq', 'mistral', 'ollama', 'openrouter']);
  // Code also picks the code model on Vibe AI.
  const plan = planRoute({ messages: norm('write a python function to sort a list') });
  assert.equal(plan.steps[0].models[0], 'codestral-latest');
});

test('Automatic stays with the AI that answered before when it still fits (no needless switching)', () => {
  everyProvider();
  const norm = (c) => [{ role: 'user', content: c, images: [] }];
  assert.equal(firstPick(norm('thanks, and what about tomorrow?'), { lastProvider: 'groq' })[0], 'groq', 'groq is a top-2 pick for quick chat');
  assert.equal(firstPick(norm('thanks!'), { lastProvider: 'ollama' })[0], 'gemini', 'switches when the previous AI is a poor fit');
});

test('Automatic falls back across providers including Vibe AI, and never answers twice', async () => {
  everyProvider();
  const calls = [];
  globalThis.fetch = async (url) => {
    const p = PROVIDER_OF[host(url)];
    calls.push(p);
    if (p === 'mistral') return new Response('{}', { status: 503 });
    return sse(`from ${p}`);
  };
  const events = await readNDJSON(await handleChatRequest(chatReq({ messages: msg('Refactor this function: function a(){return 1}') })));
  assert.deepEqual(calls, ['mistral', 'mistral', 'gemini']);
  assert.equal(text(events), 'from gemini');
  assert.equal(events.find((e) => e.type === 'start').mode, 'automatic');
});

test('Automatic still works when only a provider outside the main list is connected', async () => {
  setEnv({ ANTHROPIC_API_KEY: 'sk-ant-real' });
  globalThis.fetch = async () =>
    new Response(['message_start', 'content_block_delta', 'message_stop'].map((t) => `event: ${t}\ndata: ${JSON.stringify(t === 'content_block_delta' ? { type: t, delta: { type: 'text_delta', text: 'ok' } } : { type: t, message: { usage: { input_tokens: 1 } } })}\n\n`).join(''), { status: 200 });
  const events = await readNDJSON(await handleChatRequest(chatReq({ messages: msg('hi') })));
  assert.equal(text(events), 'ok');
});

test('status tells the browser Automatic is the standard mode', async () => {
  everyProvider();
  const st = await status();
  assert.equal(st.defaultMode, 'automatic');
  assert.deepEqual(st.automaticOrder, ['gemini', 'mistral', 'openrouter', 'groq', 'ollama']);
  assert.deepEqual(st.limits.responseLengths, { short: 2000, medium: 8000 });
});

// ── 4. Usage limits ──────────────────────────────────────────────────────────
test('the new limits are the defaults', () => {
  const c = getLimitConfig();
  assert.equal(c.tokensPerDay, 25_000);
  assert.equal(c.tokensPerWeek, 100_000);
  assert.equal(c.tokensPerMonth, 300_000);
  assert.equal(c.perDay, 100);
});

test('daily message limit: the 101st message of the day is refused', async () => {
  setEnv({ AI_RATE_LIMIT_PER_MINUTE: '600', AI_HOURLY_REQUESTS_PER_USER: '1000' });
  const keys = [{ key: 'user:msg', scale: 1 }];
  const t0 = Date.UTC(2026, 10, 12, 10);
  for (let i = 0; i < 100; i++) {
    const t = await beginUsage(keys, { now: t0 + i * 1000 });
    await t.finish(1);
  }
  await assert.rejects(beginUsage(keys, { now: t0 + 200_000 }), (e) => e.code === 'USAGE_LIMIT' && /daily limit of 100 messages/.test(e.message));
  // Next day it works again.
  const next = await beginUsage(keys, { now: Date.UTC(2026, 10, 13, 0, 0, 5) });
  assert.equal(next.quota.requestsUsed, 1);
});

test('daily, weekly and monthly token limits are enforced and reset on time', async () => {
  setEnv({ AI_RATE_LIMIT_PER_MINUTE: '600', AI_HOURLY_REQUESTS_PER_USER: '1000', AI_GLOBAL_DAILY_TOKENS: '100000000' });
  const keys = [{ key: 'user:tok', scale: 1 }];
  const use = async (now, n) => {
    const t = await beginUsage(keys, { now });
    await t.finish(n);
    return t;
  };
  // Monday 2026-11-02 … Sunday 2026-11-08 is one week.
  const day = (d, h = 12) => Date.UTC(2026, 10, d, h);

  // Daily: 25,000.
  await use(day(2), 25_000);
  await assert.rejects(beginUsage(keys, { now: day(2, 13) }), (e) => e.code === 'USAGE_LIMIT' && /today/.test(e.message));
  // Weekly: 100,000 → after 4 full days the week is used up even on a new day.
  await use(day(3), 25_000);
  await use(day(4), 25_000);
  await use(day(5), 25_000);
  await assert.rejects(beginUsage(keys, { now: day(6) }), (e) => e.code === 'USAGE_LIMIT' && /this week/.test(e.message) && e.extra.resetAt === '2026-11-09T00:00:00.000Z');
  // New week (Monday): allowed again; quota shows the week and month totals.
  const t = await beginUsage(keys, { now: day(9) });
  assert.equal(t.quota.weekTokensUsed, 0);
  assert.equal(t.quota.monthTokensUsed, 100_000);
  assert.equal(t.quota.weekTokensLimit, 100_000);
  assert.equal(t.quota.monthTokensLimit, 300_000);
  assert.equal(t.quota.monthResetAt, '2026-12-01T00:00:00.000Z');
  await t.finish(25_000);
  // Monthly: 300,000. Weeks of 2026-11-09 and 2026-11-16 bring the month to 300k.
  for (const d of [10, 11, 12]) await use(day(d), 25_000);
  for (const d of [16, 17, 18, 19]) await use(day(d), 25_000);
  await assert.rejects(beginUsage(keys, { now: day(23) }), (e) => e.code === 'USAGE_LIMIT' && /this month/.test(e.message) && e.extra.resetAt === '2026-12-01T00:00:00.000Z');
  // December: fresh month.
  const dec = await beginUsage(keys, { now: Date.UTC(2026, 11, 1, 0, 0, 1) });
  assert.equal(dec.quota.monthTokensUsed, 0);
});

test('the token budget for one request is the smallest of what is left today, this week and this month', async () => {
  setEnv({ AI_RATE_LIMIT_PER_MINUTE: '600', AI_HOURLY_REQUESTS_PER_USER: '1000' });
  const keys = [{ key: 'user:b', scale: 1 }];
  const mon = Date.UTC(2026, 10, 9, 12);
  for (let d = 0; d < 3; d++) await (await beginUsage(keys, { now: mon + d * 86_400_000 })).finish(25_000);
  const t = await (await beginUsage(keys, { now: mon + 3 * 86_400_000 })).finish(20_000).then(() => beginUsage(keys, { now: mon + 4 * 86_400_000 }));
  assert.equal(t.budget, 5_000, 'week has 5,000 left even though today has 25,000');
  assert.equal(t.budgetPeriod, 'week');
});

test('switching providers or modes cannot get around the limits', async () => {
  setEnv({ GEMINI_API_KEY: 'AIzaG', MISTRAL_API_KEY: 'mk', GROQ_API_KEY: 'gsk_x', AI_DAILY_TOKENS_PER_USER: '1000', AI_RATE_LIMIT_PER_MINUTE: '600' });
  globalThis.fetch = async () =>
    new Response('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"prompt_tokens":500,"completion_tokens":500}}\n\ndata: [DONE]\n\n', { status: 200 });
  const ip = { 'x-nf-client-connection-ip': '9.9.9.9' };
  const first = await readNDJSON(await handleChatRequest(chatReq({ provider: 'gemini', messages: msg('one') }, ip)));
  assert.equal(first.find((e) => e.type === 'done').quota.tokensUsed, 1000);
  for (const provider of ['mistral', 'groq', 'automatic', 'default']) {
    const res = await handleChatRequest(chatReq({ provider, messages: msg(`two ${provider}`) }, ip));
    assert.equal(res.status, 429, `${provider} is blocked too`);
    assert.equal((await res.json()).error.code, 'USAGE_LIMIT');
  }
});

test('Medium Response Tokens (8,000) is the standard reply length; Short is available', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x' });
  const sent = [];
  globalThis.fetch = async (_u, init) => (sent.push(JSON.parse(init.body).max_tokens), sse('ok'));
  await (await handleChatRequest(chatReq({ messages: msg('a') }))).text();
  await (await handleChatRequest(chatReq({ messages: msg('b'), options: { responseLength: 'medium' } }))).text();
  await (await handleChatRequest(chatReq({ messages: msg('c'), options: { responseLength: 'short' } }))).text();
  assert.deepEqual(sent, [8000, 8000, 2000]);
});

test('a reply never uses more tokens than are left in the allowance (input counted too)', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x', AI_DAILY_TOKENS_PER_USER: '3000', AI_RATE_LIMIT_PER_MINUTE: '600' });
  let max;
  globalThis.fetch = async (_u, init) => ((max = JSON.parse(init.body).max_tokens), sse('ok'));
  await (await handleChatRequest(chatReq({ messages: msg('hello') }))).text();
  assert.ok(max < 3000 && max > 64, `reply cap ${max} leaves room for the input`);
});

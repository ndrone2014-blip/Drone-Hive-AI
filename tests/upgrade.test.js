/**
 * Tests for automatic provider selection, fallback, images and usage limits.
 * Run with: npm test   (no network or API keys needed — fetch is stubbed)
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatRequest, handleStatusRequest } from '../server/handlers.js';
import { _resetSecurityState } from '../server/security.js';
import { _resetAuthKeys } from '../server/auth.js';
import { _resetUsageState } from '../server/usage/limits.js';
import { _resetFirestoreToken } from '../server/usage/firestore.js';
import { _resetRouterState, analyzeRequest, orderModels, stripThinking } from '../server/ai/router.js';

const realFetch = globalThis.fetch;
const touched = new Set();
const setEnv = (vars) => {
  for (const [k, v] of Object.entries(vars)) {
    touched.add(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
const saved = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (/^(GEMINI|OPENAI_COMPAT|OPENROUTER|GROQ|OLLAMA|ANTHROPIC|AI_|FIREBASE|USAGE_STORE|NETLIFY|DRONEHIVE|AUTH_REQUIRED|ALLOW_)/.test(k)) delete process.env[k];
  }
  _resetSecurityState();
  _resetAuthKeys();
  _resetUsageState();
  _resetRouterState();
  _resetFirestoreToken();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of touched) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  touched.clear();
});

const chatReq = (body, headers = {}) =>
  new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const readNDJSON = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
const sse = (...texts) => new Response(texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
const text = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

/** All four providers, with the same settings the live site uses for Gemini. */
function allProviders() {
  setEnv({
    OPENAI_COMPAT_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    OPENAI_COMPAT_API_KEY: 'gem-key',
    OPENAI_COMPAT_NAME: 'Google Gemini',
    OPENAI_COMPAT_MODEL: 'gemini-flash-lite-latest',
    OPENAI_COMPAT_MODELS: 'gemini-flash-latest,gemini-flash-lite-latest',
    OPENROUTER_API_KEY: 'sk-or-x',
    OPENROUTER_MODEL: 'cohere/north-mini-code:free',
    GROQ_API_KEY: 'gsk_x',
    OLLAMA_API_KEY: 'oll-x',
    AI_PROVIDER: 'openrouter',
  });
}
const hostOf = (url) => new URL(url).hostname;
const providerOf = (url) =>
  ({ 'generativelanguage.googleapis.com': 'gemini', 'openrouter.ai': 'openrouter', 'api.groq.com': 'groq', 'ollama.com': 'ollama' })[hostOf(url)];

// ── Providers & status ───────────────────────────────────────────────────────
test('Gemini is picked up from the existing OPENAI_COMPAT settings and listed first', async () => {
  allProviders();
  const status = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  const ids = status.providers.filter((p) => p.configured).map((p) => p.id);
  assert.deepEqual(ids, ['gemini', 'openrouter', 'groq', 'ollama']);
  assert.equal(status.providers.find((p) => p.id === 'openai-compatible').configured, false, 'not listed twice');
  assert.equal(status.activeProvider, 'openrouter', 'Default mode keeps AI_PROVIDER');
  assert.deepEqual(status.modes, ['automatic', 'default']);
  assert.equal(status.defaultMode, 'automatic');
  assert.equal(status.vision, true);
  const raw = JSON.stringify(status);
  for (const secret of ['gem-key', 'sk-or-x', 'gsk_x', 'oll-x']) assert.ok(!raw.includes(secret), `${secret} leaked`);
});

// ── Automatic mode ───────────────────────────────────────────────────────────
test('Automatic mode tries Gemini first and only calls one provider when it succeeds', async () => {
  allProviders();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ p: providerOf(url), body: JSON.parse(init.body) });
    return sse('Hi', ' there');
  };
  const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'automatic', messages: [{ role: 'user', content: 'hello!' }] })));
  assert.deepEqual(calls.map((c) => c.p), ['gemini']);
  const start = events.find((e) => e.type === 'start');
  assert.equal(start.provider.id, 'gemini');
  assert.equal(start.mode, 'automatic');
  assert.equal(start.rerouted, false);
  assert.equal(text(events), 'Hi there');
  assert.equal(calls[0].body.model, 'gemini-flash-lite-latest', 'simple chat uses the faster model');
});

test('Automatic mode picks a stronger model for coding work', async () => {
  allProviders();
  let body;
  globalThis.fetch = async (_u, init) => ((body = JSON.parse(init.body)), sse('ok'));
  await (await handleChatRequest(chatReq({ provider: 'automatic', messages: [{ role: 'user', content: 'Fix this bug:\n```js\nconst x = ;\n```' }] }))).text();
  assert.equal(body.model, 'gemini-flash-latest');
});

test('Automatic mode falls back in priority order and remembers the busy provider', async () => {
  allProviders();
  const calls = [];
  globalThis.fetch = async (url) => {
    const p = providerOf(url);
    calls.push(p);
    if (p === 'gemini') return new Response('{"error":{"message":"gem-internal-xyz"}}', { status: 429, headers: { 'retry-after': '30' } });
    if (p === 'groq') return new Response('{"error":"down"}', { status: 503 });
    return sse('from openrouter');
  };
  const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'automatic', messages: [{ role: 'user', content: 'hi' }] })));
  // Quick chat ranks Gemini, then Groq. Each provider's two models are tried
  // (free limits are per model), then the next provider answers.
  assert.deepEqual(calls, ['gemini', 'gemini', 'groq', 'groq', 'openrouter']);
  const start = events.find((e) => e.type === 'start');
  assert.equal(start.provider.id, 'openrouter');
  assert.equal(start.rerouted, true);
  assert.equal(text(events), 'from openrouter');
  assert.ok(!JSON.stringify(events).includes('gem-internal-xyz'), 'provider errors are not shown to users');

  // Next request: Gemini and Groq are cooling down, so OpenRouter is asked first.
  calls.length = 0;
  await (await handleChatRequest(chatReq({ provider: 'automatic', messages: [{ role: 'user', content: 'again' }] }))).text();
  assert.equal(calls[0], 'openrouter');
});

test('Ollama is the final fallback, and a clear message is shown if everything fails', async () => {
  allProviders();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(providerOf(url));
    return new Response('{}', { status: 503 });
  };
  const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'automatic', messages: [{ role: 'user', content: 'hi' }] })));
  assert.equal(calls.at(-1), 'ollama');
  const err = events.at(-1);
  assert.equal(err.type, 'error');
  assert.equal(err.error.code, 'ALL_PROVIDERS_FAILED');
});

test('a reply that fails half-way is NOT re-sent to another provider', async () => {
  allProviders();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(providerOf(url));
    const body = 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\ndata: {"error":{"message":"boom-internal"}}\n\n';
    return new Response(body, { status: 200 });
  };
  const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'automatic', messages: [{ role: 'user', content: 'hi' }] })));
  assert.deepEqual(calls, ['gemini']);
  assert.equal(text(events), 'Partial');
  assert.equal(events.at(-1).type, 'error');
  assert.ok(!JSON.stringify(events).includes('boom-internal'));
});

test('an empty reply counts as a failure and moves on', async () => {
  allProviders();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(providerOf(url));
    return providerOf(url) === 'gemini' ? new Response('data: [DONE]\n\n', { status: 200 }) : sse('ok');
  };
  const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'automatic', messages: [{ role: 'user', content: 'hi' }] })));
  assert.equal(events.find((e) => e.type === 'start').provider.id, 'groq', 'next best for quick chat');
});

test('Default mode uses AI_PROVIDER first; manual mode never switches provider', async () => {
  allProviders();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(providerOf(url));
    return providerOf(url) === 'groq' ? new Response('{}', { status: 503 }) : sse('ok');
  };
  await (await handleChatRequest(chatReq({ provider: 'default', messages: [{ role: 'user', content: 'hi' }] }))).text();
  assert.equal(calls[0], 'openrouter');

  calls.length = 0;
  const events = await readNDJSON(await handleChatRequest(chatReq({ provider: 'groq', messages: [{ role: 'user', content: 'hi 2' }] })));
  assert.ok(calls.every((c) => c === 'groq'), 'manual choice is respected');
  assert.equal(events.at(-1).type, 'error');

  // Legacy value "auto" from older browsers means Default
  calls.length = 0;
  await (await handleChatRequest(chatReq({ provider: 'auto', messages: [{ role: 'user', content: 'hi 3' }] }))).text();
  assert.equal(calls[0], 'openrouter');
});

test('choosing a provider that is not connected gives a clear error', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x' });
  const res = await handleChatRequest(chatReq({ provider: 'gemini', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /isn’t connected/);
});

test('request analysis and model ordering', () => {
  assert.equal(analyzeRequest([{ role: 'user', content: 'write a python function to sort', images: [] }]).kind, 'code');
  assert.equal(analyzeRequest([{ role: 'user', content: 'why is the sky blue? explain', images: [] }]).kind, 'reasoning');
  assert.equal(analyzeRequest([{ role: 'user', content: 'hey!', images: [] }]).complex, false);
  const or = { models: ['cohere/north-mini-code:free', 'openrouter/free', 'openai/gpt-oss-120b:free'], visionModels: ['openrouter/free'] };
  assert.equal(orderModels(or, { kind: 'code', complex: true })[0], 'cohere/north-mini-code:free');
  assert.equal(orderModels(or, { kind: 'chat', complex: false })[0], 'openrouter/free');
  assert.deepEqual(orderModels(or, { kind: 'vision', needsVision: true }), ['openrouter/free']);
});

test('hidden <think> reasoning is removed from replies', async () => {
  async function* gen(parts) {
    for (const p of parts) yield { type: 'delta', text: p };
    yield { type: 'done' };
  }
  const collect = async (parts) => {
    let out = '';
    for await (const ev of stripThinking(gen(parts))) if (ev.type === 'delta') out += ev.text;
    return out;
  };
  assert.equal(await collect(['<thi', 'nk>secret plan</th', 'ink>\n\nAnswer']), 'Answer');
  assert.equal(await collect(['Normal ', 'answer <think> stays']), 'Normal answer <think> stays');
});

// ── Images ───────────────────────────────────────────────────────────────────
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64');
const imgMsg = (img) => ({ provider: 'automatic', messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, img] }] });

test('images are validated and sent to a vision model as data URLs', async () => {
  allProviders();
  let body;
  globalThis.fetch = async (_u, init) => ((body = JSON.parse(init.body)), sse('A cat'));
  const events = await readNDJSON(await handleChatRequest(chatReq(imgMsg({ type: 'image', mediaType: 'image/png', data: PNG }))));
  assert.equal(text(events), 'A cat');
  const user = body.messages.at(-1);
  assert.equal(user.content[0].text, 'What is this?');
  assert.equal(user.content[1].type, 'image_url');
  assert.ok(user.content[1].image_url.url.startsWith('data:image/png;base64,'));
});

test('fake, dangerous or oversized images are rejected on the server', async () => {
  allProviders();
  globalThis.fetch = async () => sse('should not be called');
  const cases = [
    { type: 'image', mediaType: 'image/svg+xml', data: Buffer.from('<svg onload=alert(1)>').toString('base64') },
    { type: 'image', mediaType: 'image/png', data: Buffer.from('<script>alert(1)</script>xxxxxxxxxxxxxxxxxxxxxxxxxxxx').toString('base64') },
    { type: 'image', mediaType: 'image/jpeg', data: PNG }, // PNG bytes claiming to be JPEG
    { type: 'image', mediaType: 'image/png', data: 'not base64!!' },
    { type: 'image', mediaType: 'application/x-msdownload', data: PNG },
  ];
  for (const img of cases) {
    const res = await handleChatRequest(chatReq(imgMsg(img)));
    assert.equal(res.status, 400, img.mediaType);
    assert.equal((await res.json()).error.code, 'INVALID_IMAGE');
  }
  const five = { provider: 'automatic', messages: [{ role: 'user', content: Array.from({ length: 5 }, () => ({ type: 'image', mediaType: 'image/png', data: PNG })) }] };
  assert.equal((await handleChatRequest(chatReq(five))).status, 400);
});

test('images skip providers that cannot see them', async () => {
  setEnv({ OPENAI_COMPAT_BASE_URL: 'https://example.test/v1', OPENAI_COMPAT_API_KEY: 'k', OPENAI_COMPAT_MODEL: 'text-only' });
  const res = await handleChatRequest(chatReq({ ...imgMsg({ type: 'image', mediaType: 'image/png', data: PNG }), provider: 'openai-compatible' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'VISION_UNSUPPORTED');
});

// ── Usage limits ─────────────────────────────────────────────────────────────
const ask = (content, ip = '9.9.9.9', extra = {}) => handleChatRequest(chatReq({ messages: [{ role: 'user', content }], stream: false, ...extra }), { ip });

test('hourly and daily message limits are enforced on the server', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x', AI_HOURLY_REQUESTS_PER_USER: '2', AI_RATE_LIMIT_PER_MINUTE: '50' });
  globalThis.fetch = async () => sse('ok');
  assert.equal((await ask('a')).status, 200);
  assert.equal((await ask('b')).status, 200);
  const blocked = await ask('c');
  assert.equal(blocked.status, 429);
  const err = (await blocked.json()).error;
  assert.equal(err.code, 'USAGE_LIMIT');
  assert.match(err.message, /hourly limit/);

  setEnv({ AI_HOURLY_REQUESTS_PER_USER: '100', AI_DAILY_REQUESTS_PER_USER: '1' });
  _resetUsageState();
  assert.equal((await ask('d', '8.8.8.8')).status, 200);
  assert.match((await (await ask('e', '8.8.8.8')).json()).error.message, /daily limit/);
});

test('global daily limit stops everyone, and the emergency stop pauses the AI', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x', AI_GLOBAL_DAILY_REQUESTS: '2' });
  globalThis.fetch = async () => sse('ok');
  assert.equal((await ask('a', '1.0.0.1')).status, 200);
  assert.equal((await ask('b', '1.0.0.2')).status, 200);
  const res = await ask('c', '1.0.0.3');
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'GLOBAL_LIMIT');

  _resetUsageState();
  setEnv({ AI_GLOBAL_DAILY_REQUESTS: undefined, AI_EMERGENCY_STOP: 'true' });
  let called = false;
  globalThis.fetch = async () => ((called = true), sse('ok'));
  const paused = await ask('d', '1.0.0.4');
  assert.equal(paused.status, 503);
  assert.equal((await paused.json()).error.code, 'SERVICE_PAUSED');
  assert.equal(called, false, 'no AI request is made while paused');
});

test('invalid requests do not use up anyone’s allowance', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x', AI_DAILY_REQUESTS_PER_USER: '1' });
  globalThis.fetch = async () => sse('ok');
  for (let i = 0; i < 3; i++) assert.equal((await handleChatRequest(chatReq({ messages: [] }), { ip: '7.7.7.7' })).status, 400);
  assert.equal((await ask('real one', '7.7.7.7')).status, 200);
});

test('duplicate submissions of a message that is still being answered are refused', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x' });
  let release;
  const gate = new Promise((r) => (release = r));
  globalThis.fetch = async () => {
    await gate;
    return sse('ok');
  };
  const first = handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'same' }] }), { ip: '6.6.6.6' });
  const firstRes = await first; // streaming response returns right away
  const dup = await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'same' }] }), { ip: '6.6.6.6' });
  assert.equal(dup.status, 409);
  release();
  await firstRes.text();
  // Once finished, the same text can be sent again (e.g. Regenerate)
  assert.equal((await ask('same', '6.6.6.6', { stream: true })).status, 200);
});

test('the done event reports the user’s remaining daily usage', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x', AI_DAILY_REQUESTS_PER_USER: '50' });
  globalThis.fetch = async () => sse('ok');
  const events = await readNDJSON(await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'hi' }] }), { ip: '5.5.5.5' }));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.quota.requestsUsed, 1);
  assert.equal(done.quota.requestsLimit, 50);
  assert.ok(done.quota.tokensUsed > 0);
});

test('Firestore keeps shared counters (hashed IDs) and admin settings apply without a redeploy', async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\\n${pkcs8.match(/.{1,64}/g).join('\\n')}\\n-----END PRIVATE KEY-----\\n`;
  setEnv({ GROQ_API_KEY: 'gsk_x', FIREBASE_PROJECT_ID: 'proj', FIREBASE_CLIENT_EMAIL: 'svc@proj.iam.gserviceaccount.com', FIREBASE_PRIVATE_KEY: pem, AUTH_REQUIRED: 'false', AI_DAILY_REQUESTS_PER_USER: '3' });

  const docs = new Map();
  const commits = [];
  let admin = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (u.endsWith('/documents/config/limits')) return admin ? Response.json({ fields: admin }) : new Response('{}', { status: 404 });
    if (u.endsWith(':commit')) {
      assert.equal(init.headers.authorization, 'Bearer tok');
      const { writes } = JSON.parse(init.body);
      commits.push(writes);
      return Response.json({
        writeResults: writes.map((w) => {
          const doc = docs.get(w.update.name) || {};
          const transformResults = w.updateTransforms.map((t) => {
            doc[t.fieldPath] = (doc[t.fieldPath] || 0) + Number(t.increment.integerValue);
            return { integerValue: String(doc[t.fieldPath]) };
          });
          docs.set(w.update.name, doc);
          return { transformResults };
        }),
      });
    }
    return sse('ok');
  };

  for (let i = 0; i < 3; i++) assert.equal((await ask(`m${i}`, '203.0.113.9')).status, 200);
  // A brand-new edge server (memory wiped) still sees the shared count.
  _resetUsageState();
  const blocked = await ask('m4', '203.0.113.9');
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'USAGE_LIMIT');

  const names = [...docs.keys()].join(' ');
  assert.ok(!names.includes('203.0.113.9'), 'IP addresses are never stored in plain text');
  assert.match(names, /usage\/\d{4}-\d{2}-\d{2}__global/);
  assert.ok([...docs.values()].some((d) => d.tokens > 0), 'tokens are recorded after each reply');

  // Admin flips the kill switch in the Firebase console
  _resetUsageState();
  admin = { emergencyStop: { booleanValue: true } };
  const paused = await ask('m5', '198.51.100.1');
  assert.equal(paused.status, 503);
});

test('a public deployment never connects to an Ollama on a private network', async () => {
  setEnv({ OLLAMA_BASE_URL: 'http://localhost:11434/v1', NETLIFY: 'true' });
  const status = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  assert.equal(status.providers.find((p) => p.id === 'ollama').configured, false);
  setEnv({ OLLAMA_BASE_URL: 'http://192.168.1.20:11434/v1' });
  const status2 = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  assert.equal(status2.providers.find((p) => p.id === 'ollama').configured, false);
  // On your own PC (npm start) it still works
  setEnv({ NETLIFY: undefined, OLLAMA_BASE_URL: 'http://localhost:11434/v1' });
  const status3 = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  assert.equal(status3.providers.find((p) => p.id === 'ollama').configured, true);
});

// ── Credential safety ────────────────────────────────────────────────────────
test('API keys are scrubbed from server log text', async () => {
  const { redact } = await import('../server/ai/errors.js');
  setEnv({ GROQ_API_KEY: 'gsk_ThisIsMyRealGroqKey123' });
  const out = redact('Invalid key gsk_ThisIsMyRealGroqKey123; also sk-or-v1-abcdef1234567890 and AIzaSyA1234567890abcdefghijklmnop and Bearer abc.def.ghijklmnopqrstu');
  for (const secret of ['gsk_ThisIs', 'sk-or-v1-abc', 'AIzaSy', 'abc.def.ghij']) assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
});

test('no API keys or private keys are committed in the project files', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const offenders = [];
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.netlify'].includes(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (/\.(js|mjs|json|html|css|md|toml|webmanifest|txt|example)$/.test(ent.name) && !p.includes(`${path.sep}tests${path.sep}`)) {
        const t = await fs.readFile(p, 'utf8');
        if (/\b(gsk_[A-Za-z0-9]{20,}|sk-or-v1-[a-f0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) offenders.push(p);
      }
    }
  }
  await walk(root);
  assert.deepEqual(offenders, []);
});

test('a message no AI could answer is not counted against the daily allowance', async () => {
  setEnv({ GROQ_API_KEY: 'gsk_x', AI_DAILY_REQUESTS_PER_USER: '1', AI_RATE_LIMIT_PER_MINUTE: '50' });
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  for (let i = 0; i < 3; i++) assert.equal((await ask(`fail ${i}`, '4.3.2.1')).status, 503);
  globalThis.fetch = async () => sse('ok');
  assert.equal((await ask('works now', '4.3.2.1')).status, 200, 'failed attempts were refunded');
  assert.equal((await ask('over the limit', '4.3.2.1')).status, 429);
});

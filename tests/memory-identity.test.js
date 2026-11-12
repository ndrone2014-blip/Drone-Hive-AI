/**
 * Tests for the permanent Drone Hive AI identity and the memory system.
 * Run with: npm test   (no network or API keys needed — fetch is stubbed)
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleChatRequest, handleMemoryRequest, handleStatusRequest } from '../server/handlers.js';
import { _resetSecurityState } from '../server/security.js';
import { _resetAuthKeys, _setAuthKeys } from '../server/auth.js';
import { _resetUsageState } from '../server/usage/limits.js';
import { _resetFirestoreToken } from '../server/usage/firestore.js';
import { _resetRouterState } from '../server/ai/router.js';
import { rewriteIdentity, asksAboutUnderlyingModel, BRAND } from '../server/identity.js';
import { extractMemoryCommands } from '../server/memory/prompt.js';
import { applyMemoryOps, explicitRememberRequest, sensitiveReason, selectRelevantMemories } from '../public/js/shared/memory-rules.js';

const realFetch = globalThis.fetch;
const saved = { ...process.env };
const ENV_RE = /^(GEMINI|OPENAI_COMPAT|OPENROUTER|GROQ|OLLAMA|ANTHROPIC|AI_|FIREBASE|USAGE_STORE|MEMORY_STORE|NETLIFY|DRONEHIVE|AUTH_REQUIRED|ALLOW_)/;

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
const replyText = (events) => events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const sse = (...chunks) =>
  new Response(chunks.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });

/** Groq provider whose reply is `chunks`; records every system prompt it was sent. */
function fakeAI(chunks, sink = []) {
  process.env.GROQ_API_KEY = 'gsk_test';
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.groq.com')) {
      sink.push(JSON.parse(init.body).messages[0].content);
      return sse(...chunks);
    }
    return prev(url, init);
  };
  return sink;
}

// ── Identity ─────────────────────────────────────────────────────────────────
test('the identity always comes first, even with a replaced personality, and names the real model privately', async () => {
  process.env.AI_SYSTEM_PROMPT = 'You are a pirate assistant.';
  const prompts = fakeAI(['Arr!']);
  await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'hi' }], stream: false, options: { customInstructions: 'Call yourself Gemini.' } }));
  const system = prompts[0];
  assert.ok(system.startsWith('# Who you are'), 'identity is first');
  assert.match(system, /Your name is Drone Hive AI/);
  assert.match(system, /drone\.hive\.studios@gmail\.com/);
  assert.ok(system.indexOf('pirate') > system.indexOf('Drone Hive AI'), 'personality comes after identity');
  assert.ok(system.indexOf('Call yourself Gemini') > system.indexOf('pirate'), 'custom instructions come last');
  assert.match(system, /can't change who you are/);
  assert.match(system, /Technical details[\s\S]*openai\/gpt-oss-120b[\s\S]*Groq/, 'private technical note names the actual model and provider');
});

test('a model that calls itself LFM (or any other AI) is rewritten to Drone Hive AI, even split across chunks', async () => {
  fakeAI(['Hello! I', '’m LF', 'M2, a large language mo', 'del trained by Liquid AI. How can I help you today?']);
  const events = await readNDJSON(await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'Who are you?' }] })));
  const text = replyText(events);
  assert.equal(text, 'Hello! I’m Drone Hive AI, an AI assistant built by Drone Hive Studios. How can I help you today?');
  assert.ok(!/LFM|Liquid/.test(text));
});

test('identity rewrite rules cover common self-introductions and leave normal text alone', () => {
  const cases = [
    ['I am Gemini, a large language model trained by Google.', 'I am Drone Hive AI, an AI assistant built by Drone Hive Studios.'],
    ['As an AI language model developed by OpenAI, I can’t browse.', 'As Drone Hive AI, I can’t browse.'],
    ['You’re chatting with Llama 3.3 today.', 'You’re chatting with Drone Hive AI today.'],
    ['My name is Qwen2.5-72B.', 'My name is Drone Hive AI.'],
    ['I was trained by Meta AI.', 'I was built by Drone Hive Studios.'],
    // Unchanged:
    ['Here is how to call the Gemini API with GPT-4 as a fallback.', null],
    ['I am glad you asked about Gemini’s pricing.', null],
    ['I’m using gpt-oss-120b in this example.', null],
  ];
  for (const [input, expected] of cases) assert.equal(rewriteIdentity(input), expected ?? input, input);
});

test('the stream guard waits for full model names, and never changes code blocks', async () => {
  const { guardIdentity } = await import('../server/identity.js');
  const source = 'I am Claude 3.5 Sonnet.\n\n```python\nprint("I am Gemini")\n```\nI was trained by Google DeepMind. ' + 'More text. '.repeat(20);
  for (const step of [1, 2, 7, 40]) {
    async function* src() {
      for (let i = 0; i < source.length; i += step) yield { type: 'delta', text: source.slice(i, i + step) };
      yield { type: 'done' };
    }
    let out = '';
    for await (const ev of guardIdentity(src())) if (ev.type === 'delta') out += ev.text;
    assert.ok(out.startsWith('I am Drone Hive AI.\n\n```python\nprint("I am Gemini")\n```\nI was built by Drone Hive Studios. More text.'), `chunk size ${step}: ${out.slice(0, 120)}`);
  }
});

test('when the user asks what powers the assistant, the truthful answer is not rewritten', async () => {
  assert.equal(asksAboutUnderlyingModel('What model are you running on?'), true);
  assert.equal(asksAboutUnderlyingModel('Are you Gemini?'), true);
  assert.equal(asksAboutUnderlyingModel('Who are you?'), false);
  fakeAI(['Drone Hive AI is built by Drone Hive Studios; I am GPT-OSS 120B running through Groq.']);
  const events = await readNDJSON(await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'Which underlying model powers you?' }] })));
  assert.match(replyText(events), /I am GPT-OSS 120B running through Groq/);
});

test('status shares the official contact email and where memories are stored', async () => {
  const status = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  assert.equal(status.app.email, BRAND.email);
  assert.equal(status.app.name, 'Drone Hive AI');
  assert.equal(status.memory.store, 'browser');
});

// ── Memory rules ─────────────────────────────────────────────────────────────
test('passwords, keys, tokens and card numbers are never saved as memories', () => {
  for (const secret of [
    'My password is hunter2',
    'API key: sk-or-v1-abcdefghijklmnop',
    // Built at runtime so no token-shaped text is committed (GitHub push protection).
    ['Discord bot token = MTIz', 'NDU2Nzg5MDEyMzQ1Njc4', '.GhIjKl.', 'abcdefghijklmnopqrstuvwxyz0123'].join(''),
    ['gsk', '_abcdefghijklmnopqrstuvwxyz'].join(''),
    'card 4111 1111 1111 1111',
    ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'signature'].join('.'),
  ]) {
    assert.ok(sensitiveReason(secret), secret);
  }
  for (const ok of ['Prefers TypeScript and React', 'Keeps API keys in Netlify environment variables', 'Building Nexora, a Discord bot (discord.js v14)', 'Lives in Carmi, Illinois']) {
    assert.equal(sensitiveReason(ok), null, ok);
  }
  const r = applyMemoryOps([], [{ op: 'add', text: 'Prefers tabs' }, { op: 'add', text: 'prefers TABS!' }, { op: 'add', text: 'my password is abc' }]);
  assert.equal(r.items.length, 1, 'duplicates and secrets are skipped');
  assert.deepEqual(r.rejected.map((x) => x.reason.split(' ')[0]), ['duplicate', 'it']);
});

test('"remember that …" requests become memories written in the third person', () => {
  assert.equal(explicitRememberRequest('remember that I prefer tabs over spaces'), 'User prefers tabs over spaces');
  assert.equal(explicitRememberRequest('Please remember my name is Nate'), 'User’s name is Nate');
  assert.equal(explicitRememberRequest('remember to add tests'), null);
  assert.equal(explicitRememberRequest('what do you remember about me?'), null);
});

test('only relevant memories are sent, but facts about the person always are', () => {
  const list = [
    { id: 'a', text: 'Name is Nate', category: 'about', updatedAt: 1 },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, text: `Unrelated project number ${i} about gardening`, category: 'project', updatedAt: 1 })),
    { id: 'b', text: 'Building Nexora, a Discord bot with discord.js', category: 'project', updatedAt: 1 },
  ];
  const picked = selectRelevantMemories(list, 'help me add a slash command to my discord bot').map((m) => m.id);
  assert.ok(picked.includes('a') && picked.includes('b'));
  assert.ok(!picked.includes('p3'), 'unrelated project memories are left out');
});

test('memory tags are removed from replies and turned into operations', async () => {
  async function* src() {
    for (const t of ['Sure — noted.\n\n[[memo', 'ry:add|tech|Uses discord.js v14]]\n[[memory:delete|m2]]']) yield { type: 'delta', text: t };
    yield { type: 'done' };
  }
  const out = [];
  for await (const ev of extractMemoryCommands(src())) out.push(ev);
  assert.equal(replyText(out), 'Sure — noted.');
  const ops = out.find((e) => e.type === 'memory_ops').ops;
  assert.deepEqual(ops, [{ op: 'add', category: 'tech', text: 'Uses discord.js v14' }, { op: 'delete', id: 'm2' }]);
  assert.equal(out.at(-1).type, 'done');
});

// ── Memory in chats (stored in the browser) ──────────────────────────────────
test('browser-stored memories reach the AI, and new ones come back for the browser to save', async () => {
  const prompts = fakeAI(['Got it, Nate. ', '[[memory:add|preference|Prefers short answers]]', '[[memory:update|m1|Name is Nathan]]']);
  const events = await readNDJSON(
    await handleChatRequest(
      chatReq({
        messages: [{ role: 'user', content: 'Keep answers short from now on. Also my name is actually Nathan.' }],
        memory: {
          enabled: true,
          auto: true,
          items: [
            { id: 'mem-name', text: 'Name is Nate', category: 'about' },
            { id: 'mem-secret', text: 'Password is hunter2', category: 'about' },
          ],
          recent: ['Nexora slash commands'],
        },
      }),
    ),
  );
  const system = prompts[0];
  assert.match(system, /\[m1\] \(About you\) Name is Nate/);
  assert.ok(!system.includes('hunter2'), 'secrets sent by a browser are dropped');
  assert.match(system, /Nexora slash commands/);
  assert.equal(replyText(events), 'Got it, Nate.');
  const mem = events.find((e) => e.type === 'memory');
  assert.equal(mem.store, 'browser');
  assert.deepEqual(mem.ops, [
    { op: 'add', text: 'Prefers short answers', category: 'preference', source: 'chat' },
    { op: 'update', id: 'mem-name', text: 'Name is Nathan' },
  ]);
  assert.ok(events.indexOf(mem) < events.findIndex((e) => e.type === 'done'), 'memory event arrives before done');
});

test('with memory off nothing is sent or saved, and stray tags never reach the user', async () => {
  const prompts = fakeAI(['Hello.', '[[memory:add|about|Likes cats]]']);
  const events = await readNDJSON(
    await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'remember I like cats' }], memory: { enabled: false, items: [{ id: 'x', text: 'Name is Nate' }] } })),
  );
  assert.ok(!prompts[0].includes('# Memory'));
  assert.ok(!prompts[0].includes('Nate'));
  assert.equal(replyText(events), 'Hello.');
  assert.equal(events.find((e) => e.type === 'memory'), undefined);
});

test('a "remember …" request is saved even if the AI forgets to, and secrets are refused', async () => {
  fakeAI(['Sure!']);
  let events = await readNDJSON(await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'Remember that I use Vim' }], memory: { enabled: true, auto: false, items: [] } })));
  assert.deepEqual(events.find((e) => e.type === 'memory').ops, [{ op: 'add', text: 'User uses Vim', category: 'other', source: 'chat' }]);

  fakeAI(['Okay. [[memory:add|about|Password is hunter2]]']);
  events = await readNDJSON(await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'my password is hunter2, remember it' }], memory: { enabled: true, items: [] } })));
  const mem = events.find((e) => e.type === 'memory');
  assert.deepEqual(mem.ops ?? [], []);
  assert.equal(mem.rejected[0].sensitive, true);
  assert.ok(!JSON.stringify(events).includes('hunter2'), 'the secret is not echoed back');
});

test('/api/memory explains that memories live in the browser when account storage is off', async () => {
  const res = await handleMemoryRequest(new Request('http://local/api/memory'));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'MEMORY_IN_BROWSER');
});

// ── Memory in the account (Firestore) ────────────────────────────────────────
const PROJECT = 'dhai-mem';
const b64url = (input) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
let signer;
async function token(sub) {
  if (!signer) {
    signer = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  }
  _setAuthKeys(new Map([['k1', signer.publicKey]]));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub, iat: now - 5, auth_time: now - 5, exp: now + 3600, email: `${sub}@example.com`, email_verified: true, firebase: { sign_in_provider: 'password' } }),
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

/** Sign-in + Firestore + Groq, all stubbed. Returns the fake database. */
async function accountSetup(reply = ['ok']) {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
  Object.assign(process.env, {
    FIREBASE_API_KEY: 'public-web-key',
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_CLIENT_EMAIL: `svc@${PROJECT}.iam.gserviceaccount.com`,
    FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\\n${pkcs8.match(/.{1,64}/g).join('\\n')}\\n-----END PRIVATE KEY-----\\n`,
    USAGE_STORE: 'memory', // usage counters in memory; memories still use Firestore
    GROQ_API_KEY: 'gsk_test',
  });
  const db = new Map(); // name -> { fields, updateTime }
  const state = { prompts: [], reply, commits: 0 };
  let clock = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
    if (u.startsWith('https://api.groq.com')) {
      state.prompts.push(JSON.parse(init.body).messages[0].content);
      return sse(...state.reply);
    }
    if (u.includes('firestore.googleapis.com')) {
      assert.equal(init.headers?.authorization, 'Bearer tok');
      if (u.endsWith(':commit')) {
        state.commits += 1;
        for (const w of JSON.parse(init.body).writes) {
          const name = w.update?.name || w.delete;
          const cur = db.get(name);
          if (w.currentDocument?.exists === false && cur) return new Response('{"error":{"status":"FAILED_PRECONDITION"}}', { status: 400 });
          if (w.currentDocument?.updateTime && cur?.updateTime !== w.currentDocument.updateTime) return new Response('{"error":{"status":"FAILED_PRECONDITION"}}', { status: 400 });
          if (w.delete) db.delete(name);
          else db.set(name, { fields: w.update.fields, updateTime: `t${++clock}` });
        }
        return Response.json({ writeResults: [{}] });
      }
      const name = decodeURIComponent(u.split('/v1/')[1]);
      const doc = db.get(name);
      return doc ? Response.json({ name, ...doc }) : new Response('{}', { status: 404 });
    }
    return new Response('not stubbed', { status: 500 });
  };
  return { db, state };
}
const memReq = (method, tok, { body, query = '' } = {}) =>
  new Request(`http://local/api/memory${query}`, {
    method,
    headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test('account memories: add, view, edit, delete and clear through /api/memory, saved under a hashed id', async () => {
  const { db } = await accountSetup();
  const alice = await token('alice-uid');
  const status = await (await handleStatusRequest(new Request('http://local/api/status'))).json();
  assert.equal(status.memory.store, 'account');

  assert.equal((await handleMemoryRequest(memReq('GET'))).status, 401, 'sign-in required');

  let res = await handleMemoryRequest(memReq('POST', alice, { body: { text: 'Prefers TypeScript', category: 'tech' } }));
  assert.equal(res.status, 200);
  let data = await res.json();
  assert.equal(data.items.length, 1);
  const id = data.items[0].id;

  res = await handleMemoryRequest(memReq('POST', alice, { body: { text: 'My password is hunter2' } }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /never stores passwords/);

  res = await handleMemoryRequest(memReq('PATCH', alice, { body: { id, text: 'Prefers TypeScript with strict mode' } }));
  assert.equal((await res.json()).items[0].text, 'Prefers TypeScript with strict mode');

  data = await (await handleMemoryRequest(memReq('GET', alice))).json();
  assert.deepEqual(data.items.map((m) => m.text), ['Prefers TypeScript with strict mode']);
  assert.ok(![...db.keys()].join(' ').includes('alice-uid'), 'account ids are never stored in plain text');

  await handleMemoryRequest(memReq('POST', alice, { body: { text: 'Uses Netlify', category: 'tech' } }));
  res = await handleMemoryRequest(memReq('DELETE', alice, { query: `?id=${encodeURIComponent(id)}` }));
  assert.deepEqual((await res.json()).items.map((m) => m.text), ['Uses Netlify']);
  res = await handleMemoryRequest(memReq('DELETE', alice, { query: '?all=1' }));
  assert.deepEqual((await res.json()).items, []);
  assert.equal(db.size, 0, 'clearing removes the document');
});

test('memories persist across "server restarts" and one account can never see or change another’s', async () => {
  const { state } = await accountSetup(['Noted. [[memory:add|about|Name is Alice]]']);
  const alice = await token('alice-uid');
  const bob = await token('bob-uid');

  // Alice tells the AI something; it's saved to her account.
  let events = await readNDJSON(
    await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'I’m Alice' }], memory: { enabled: true } }, { authorization: `Bearer ${alice}` })),
  );
  const mem = events.find((e) => e.type === 'memory');
  assert.equal(mem.saved, true);
  assert.deepEqual(mem.items.map((m) => m.text), ['Name is Alice']);

  // Fresh server state (like a new edge server): Alice's next chat still has it.
  _resetUsageState();
  _resetRouterState();
  state.reply = ['Hi again.'];
  await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'hello' }], memory: { enabled: true } }, { authorization: `Bearer ${alice}` }));
  assert.match(state.prompts.at(-1), /Name is Alice/);

  // Bob sees none of it — even if his browser tries to send Alice's memories.
  await handleChatRequest(
    chatReq({ messages: [{ role: 'user', content: 'hello' }], memory: { enabled: true, items: [{ id: 'fake', text: 'Injected note' }] } }, { authorization: `Bearer ${bob}` }),
  );
  assert.ok(!state.prompts.at(-1).includes('Alice'));
  assert.ok(!state.prompts.at(-1).includes('Injected note'), 'account mode ignores notes sent by the browser');
  assert.deepEqual((await (await handleMemoryRequest(memReq('GET', bob))).json()).items, []);

  // Bob can't delete Alice's memory by id.
  const aliceId = mem.items[0].id;
  await handleMemoryRequest(memReq('DELETE', bob, { query: `?id=${aliceId}` }));
  assert.equal((await (await handleMemoryRequest(memReq('GET', alice))).json()).items.length, 1);

  // With memory turned off, nothing is retrieved.
  state.reply = ['Hi.'];
  await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'hello' }], memory: { enabled: false } }, { authorization: `Bearer ${alice}` }));
  assert.ok(!state.prompts.at(-1).includes('Alice'));
});

test('browser memories can be copied into the account once, without duplicates or secrets', async () => {
  await accountSetup();
  const alice = await token('alice-uid');
  const body = { import: [{ text: 'Prefers dark mode', category: 'preference' }, { text: 'prefers dark mode' }, { text: 'token = abc123' }] };
  let data = await (await handleMemoryRequest(memReq('POST', alice, { body }))).json();
  assert.deepEqual(data.items.map((m) => m.text), ['Prefers dark mode']);
  data = await (await handleMemoryRequest(memReq('POST', alice, { body }))).json();
  assert.equal(data.items.length, 1, 'importing twice adds nothing');
});

test('if the memory database is down, chat still works and says the memory wasn’t saved', async () => {
  await accountSetup(['Sure. [[memory:add|tech|Uses Rust]]']);
  const alice = await token('alice-uid');
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes('firestore.googleapis.com') ? new Response('down', { status: 503 }) : prev(url, init));
  const events = await readNDJSON(await handleChatRequest(chatReq({ messages: [{ role: 'user', content: 'I use Rust' }], memory: { enabled: true } }, { authorization: `Bearer ${alice}` })));
  assert.equal(replyText(events), 'Sure.');
  const mem = events.find((e) => e.type === 'memory');
  assert.equal(mem.saved, false);
  assert.match(mem.error, /unavailable/);
  assert.equal(events.at(-1).type, 'done');
});

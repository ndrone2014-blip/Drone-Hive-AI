/**
 * Browser-side memory store (public/js/core/memory-store.js), run in Node with
 * a fake localStorage, settings and server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= { addEventListener() {} };
const { MemoryStore } = await import('../public/js/core/memory-store.js');

class FakeStorage {
  constructor() {
    this.data = new Map();
  }
  load(k, fallback) {
    return this.data.has(k) ? JSON.parse(this.data.get(k)) : fallback;
  }
  save(k, v) {
    this.data.set(k, JSON.stringify(v));
    return true;
  }
  remove(k) {
    this.data.delete(k);
  }
}
const settings = (over = {}) => {
  const s = { memoryEnabled: true, memoryAuto: true, memoryRecentChats: true, ...over };
  return { get: (k) => s[k], set: (k, v) => (s[k] = v) };
};

test('browser storage keeps a separate memory list for each account', async () => {
  const storage = new FakeStorage();
  const m = new MemoryStore({ storage, settings: settings() });
  m.configure({ store: 'browser', authRequired: true, user: { uid: 'alice' } });
  assert.equal((await m.add('Name is Alice', 'about')).ok, true);
  assert.deepEqual(m.items.map((x) => x.text), ['Name is Alice']);

  m.configure({ store: 'browser', authRequired: true, user: { uid: 'bob' } });
  assert.deepEqual(m.items, [], 'Bob sees none of Alice’s memories');
  assert.deepEqual(m.forRequest().items, []);

  m.configure({ store: 'browser', authRequired: true, user: null });
  assert.equal(m.state, 'locked');
  assert.deepEqual(m.forRequest(), { enabled: false }, 'signed out: nothing is sent');

  m.configure({ store: 'browser', authRequired: true, user: { uid: 'alice' } });
  assert.deepEqual(m.items.map((x) => x.text), ['Name is Alice'], 'persists (reloaded from storage)');
});

test('browser storage: add, edit, delete, clear, secrets refused, and chat updates applied', async () => {
  const m = new MemoryStore({ storage: new FakeStorage(), settings: settings() });
  m.configure({ store: 'browser', authRequired: false });
  await m.add('Prefers TypeScript', 'tech');
  const bad = await m.add('My password is hunter2');
  assert.equal(bad.ok, false);
  assert.equal(bad.sensitive, true);
  const id = m.items[0].id;
  await m.update(id, { text: 'Prefers TypeScript (strict)' });
  assert.equal(m.items[0].text, 'Prefers TypeScript (strict)');

  const summary = m.applyChatEvent({ type: 'memory', store: 'browser', ops: [{ op: 'add', text: 'Uses Netlify', category: 'tech', source: 'chat' }, { op: 'delete', id }] });
  assert.deepEqual(summary.applied.map((a) => a.op), ['add', 'delete']);
  assert.deepEqual(m.items.map((x) => x.text), ['Uses Netlify']);

  await m.remove(m.items[0].id);
  assert.deepEqual(m.items, []);
  await m.add('Something');
  await m.clear();
  assert.deepEqual(m.items, []);
});

test('memory off: nothing is sent and chat updates are ignored', () => {
  const s = settings({ memoryEnabled: false });
  const m = new MemoryStore({ storage: new FakeStorage(), settings: s });
  m.configure({ store: 'browser', authRequired: false });
  assert.deepEqual(m.forRequest(), { enabled: false });
  assert.equal(m.applyChatEvent({ type: 'memory', store: 'browser', ops: [{ op: 'add', text: 'Likes cats' }] }), null);
  assert.deepEqual(m.items, []);
});

test('account storage talks to /api/memory with the sign-in token and never sends notes with chats', async () => {
  const calls = [];
  let items = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, auth: init.headers?.authorization, body: init.body && JSON.parse(init.body) });
    if (init.method === 'POST') items = [...items, ...(init.body ? (JSON.parse(init.body).import || [JSON.parse(init.body)]) : [])].map((x, i) => ({ id: `id${i}`, text: x.text, category: x.category || 'other' }));
    if (init.method === 'DELETE') items = [];
    return Response.json({ store: 'account', items });
  };
  const storage = new FakeStorage();
  storage.save('dhai.memory.v1.alice', [{ id: 'old', text: 'Saved before accounts', category: 'about' }]);
  const m = new MemoryStore({ storage, settings: settings(), getToken: async () => 'tok-alice' });
  m.configure({ store: 'account', authRequired: true, user: { uid: 'alice' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(m.state, 'ready');
  assert.equal(calls[0].url, '/api/memory');
  assert.equal(calls[0].auth, 'Bearer tok-alice');

  assert.equal(m.localCount, 1);
  const imported = await m.importLocal();
  assert.equal(imported.ok, true);
  assert.equal(m.localCount, 0, 'the browser copy is removed after copying');
  assert.deepEqual(m.items.map((x) => x.text), ['Saved before accounts']);

  const req = m.forRequest({ recentTitles: ['A', 'B'] });
  assert.equal(req.items, undefined, 'the server loads account notes itself');
  assert.deepEqual(req.recent, ['A', 'B']);

  m.applyChatEvent({ type: 'memory', store: 'account', saved: true, applied: [{ op: 'add', text: 'New' }], items: [{ id: 'z', text: 'New', category: 'other' }] });
  assert.deepEqual(m.items.map((x) => x.text), ['New']);

  await m.clear();
  assert.equal(calls.at(-1).url, '/api/memory?all=1');
  assert.equal(calls.at(-1).method, 'DELETE');
});

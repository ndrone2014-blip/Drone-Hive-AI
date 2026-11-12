import { Emitter } from './emitter.js';
import { API, STORAGE_KEYS } from '../config.js';
import { MEMORY_LIMITS, applyMemoryOps, sanitizeMemoryList } from '../shared/memory-rules.js';

/**
 * The user's memories (things Drone Hive AI remembers between conversations).
 *
 * Two storage places, chosen by the server (/api/status → memory.store):
 *
 *   'account'  Saved on the server under the signed-in account (Firestore) and
 *              managed through /api/memory. Follows the user to every device.
 *              Nothing is kept in the browser except a copy for display.
 *   'browser'  Saved in this browser's localStorage, in a separate list for
 *              each signed-in account (or one "guest" list when sign-in is
 *              off). Sent with each message so the AI can use it.
 *
 * Both use the shared rules in shared/memory-rules.js, so secrets (passwords,
 * keys, tokens, card numbers…) are refused everywhere.
 *
 * state: 'locked' (signed out) | 'loading' | 'ready' | 'error'
 */
export class MemoryStore extends Emitter {
  constructor({ storage, settings, getToken = async () => null }) {
    super();
    this.storage = storage;
    this.settings = settings;
    this.getToken = getToken;
    this.store = 'browser';
    this.scope = null; // 'guest' or the account id
    this.items = [];
    this.state = 'locked';
    this.error = '';
    this.loadSeq = 0;

    // Another tab changed this browser's memories: pick up the change.
    window.addEventListener('storage', (e) => {
      if (this.store === 'browser' && e.key === this.#localKey()) {
        this.items = this.#loadLocal();
        this.#emit();
      }
    });
  }

  get enabled() {
    return Boolean(this.settings.get('memoryEnabled'));
  }

  get ready() {
    return this.state === 'ready';
  }

  /** Number of notes saved in this browser for the current account (offered for import in account mode). */
  get localCount() {
    return this.scope ? sanitizeMemoryList(this.storage.load(this.#localKey(), [])).length : 0;
  }

  /**
   * Called whenever the server status or the signed-in account changes.
   * @param {{ store?: 'account'|'browser', authRequired: boolean, user: {uid:string}|null }} p
   */
  configure({ store = 'browser', authRequired = false, user = null }) {
    const scope = authRequired ? user?.uid || null : 'guest';
    const nextStore = store === 'account' && authRequired && user ? 'account' : 'browser';
    if (scope === this.scope && nextStore === this.store && this.state !== 'error') return;
    this.scope = scope;
    this.store = nextStore;
    this.items = [];
    this.error = '';
    if (!scope) {
      this.state = 'locked';
      this.#emit();
      return;
    }
    this.reload();
  }

  async reload() {
    if (!this.scope) return;
    if (this.store === 'browser') {
      this.items = this.#loadLocal();
      this.state = 'ready';
      this.#emit();
      return;
    }
    const seq = ++this.loadSeq;
    this.state = 'loading';
    this.#emit();
    try {
      const data = await this.#api('GET');
      if (seq !== this.loadSeq) return; // a newer load (e.g. another account) won
      this.items = sanitizeMemoryList(data.items);
      this.state = 'ready';
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.state = 'error';
      this.error = err.message;
    }
    this.#emit();
  }

  // ── changes made by the user (Settings → Memory) ──
  // Each returns { ok, message } so the UI can explain refusals.
  add(text, category = 'other') {
    return this.#change([{ op: 'add', text, category, source: 'manual' }], { method: 'POST', body: { text, category } });
  }

  update(id, patch) {
    return this.#change([{ op: 'update', id, ...patch }], { method: 'PATCH', body: { id, ...patch } });
  }

  remove(id) {
    return this.#change([{ op: 'delete', id }], { method: 'DELETE', query: `?id=${encodeURIComponent(id)}` });
  }

  clear() {
    return this.#change([{ op: 'clear' }], { method: 'DELETE', query: '?all=1' });
  }

  /** Account storage: copy the notes kept in this browser into the account, then remove the local copy. */
  async importLocal() {
    const local = sanitizeMemoryList(this.storage.load(this.#localKey(), []));
    if (this.store !== 'account' || !local.length) return { ok: false, message: 'Nothing to copy.' };
    try {
      const data = await this.#api('POST', { body: { import: local } });
      this.items = sanitizeMemoryList(data.items);
      this.storage.remove(this.#localKey());
      this.#emit();
      return { ok: true, message: `Copied ${local.length} memor${local.length === 1 ? 'y' : 'ies'} to your account.` };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async #change(ops, request) {
    if (!this.scope) return { ok: false, message: 'Sign in to manage memories.' };
    if (this.store === 'account') {
      try {
        const data = await this.#api(request.method, request);
        this.items = sanitizeMemoryList(data.items);
        this.#emit();
        return { ok: true };
      } catch (err) {
        return { ok: false, sensitive: /never stores/.test(err.message), message: err.message };
      }
    }
    const r = applyMemoryOps(this.items, ops);
    if (!r.applied.length && r.rejected.length) return { ok: false, sensitive: Boolean(r.rejected[0].sensitive), message: rejectionText(r.rejected[0]) };
    return this.#saveLocal(r.items) ? { ok: true } : { ok: false, message: 'Your browser’s storage is full, so this couldn’t be saved.' };
  }

  // ── changes made in chat ──
  /**
   * Handles the `memory` event from a chat reply. Returns a short summary for
   * the message chip: { applied: [{op, text}], rejected: [{reason}], error? }.
   */
  applyChatEvent(ev) {
    if (!ev || ev.type !== 'memory') return null;
    if (ev.store === 'account') {
      if (Array.isArray(ev.items) && this.store === 'account') {
        this.items = sanitizeMemoryList(ev.items);
        this.#emit();
      }
      return { applied: summarize(ev.applied), rejected: ev.rejected || [], error: ev.error || '' };
    }
    if (!this.scope || this.store !== 'browser' || !this.enabled) return null;
    const r = applyMemoryOps(this.items, ev.ops || []);
    if (r.applied.length && !this.#saveLocal(r.items)) {
      return { applied: [], rejected: [], error: 'Your browser’s storage is full, so this wasn’t saved.' };
    }
    return { applied: summarize(r.applied), rejected: [...(ev.rejected || []), ...r.rejected.filter((x) => x.sensitive || x.reason === 'full')] };
  }

  /** The `memory` part of a chat request. */
  forRequest({ recentTitles = [] } = {}) {
    if (!this.enabled || !this.scope) return { enabled: false };
    return {
      enabled: true,
      auto: Boolean(this.settings.get('memoryAuto')),
      // Account storage: the server loads the notes itself.
      ...(this.store === 'browser' ? { items: this.items.map(({ id, text, category }) => ({ id, text, category })) } : {}),
      recent: this.settings.get('memoryRecentChats') ? recentTitles.slice(0, MEMORY_LIMITS.recentTitles) : [],
    };
  }

  exportJSON() {
    return JSON.stringify({ app: 'Drone Hive AI', format: 'dhai-memories', version: 1, exportedAt: new Date().toISOString(), memories: this.items }, null, 2);
  }

  // ── storage helpers ──
  #localKey() {
    return `${STORAGE_KEYS.memory}.${this.scope || 'none'}`;
  }

  #loadLocal() {
    return sanitizeMemoryList(this.storage.load(this.#localKey(), []));
  }

  #saveLocal(items) {
    const ok = this.storage.save(this.#localKey(), items);
    if (ok) {
      this.items = items;
      this.#emit();
    }
    return ok;
  }

  async #api(method, { body, query = '' } = {}) {
    let res;
    try {
      const token = await this.getToken();
      res = await fetch(`${API.memory}${query}`, {
        method,
        cache: 'no-store',
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Couldn’t reach the Drone Hive AI server. Check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `Memory request failed (HTTP ${res.status}).`);
    return data;
  }

  #emit() {
    this.emit('change', { items: this.items, state: this.state, store: this.store });
  }
}

function summarize(applied = []) {
  return (applied || []).map((a) => ({ op: a.op, text: a.text || '' }));
}

export function rejectionText(r) {
  if (!r) return 'That couldn’t be saved.';
  if (r.sensitive) return `Not saved: ${r.reason}. Drone Hive AI never stores passwords, keys or other secrets.`;
  if (r.reason === 'duplicate') return 'That’s already saved.';
  if (r.reason === 'full') return `You’ve reached the limit of ${MEMORY_LIMITS.maxItems} memories. Delete some to add more.`;
  if (r.reason === 'not found') return 'That memory no longer exists.';
  return 'Write something to remember (at least 3 characters).';
}

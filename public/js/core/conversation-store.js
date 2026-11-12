import { Emitter } from './emitter.js';
import { STORAGE_KEYS, LIMITS } from '../config.js';

/**
 * Conversation management: create, switch, rename, delete, search, persist.
 *
 * Conversation shape:
 *   { id, title, titleLocked, createdAt, updatedAt, messages: Message[],
 *     folderId: null,       // FUTURE: conversation folders
 *     personalityId: null } // FUTURE: custom AI personalities
 *
 * Message shape:
 *   { id, role: 'user' | 'assistant' | 'notice', content, createdAt,
 *     status: 'complete' | 'streaming' | 'stopped' | 'interrupted',
 *     variant?: 'disconnected' | 'error',   // for notices
 *     attachments: [{ id, kind: 'image', name, mime, width, height, size }],
 *                                            // image data lives in IndexedDB (core/attachments.js)
 *     meta?: { provider, providerName, model, mode, rerouted, usage } }
 *
 * 'notice' messages are app messages (e.g. "AI not connected"). They are shown
 * in the chat but never sent to the AI.
 */
export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeTitle(text) {
  const clean = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'New conversation';
  if (clean.length <= LIMITS.titleLength) return clean;
  const cut = clean.slice(0, LIMITS.titleLength);
  const space = cut.lastIndexOf(' ');
  return `${(space > 24 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

export class ConversationStore extends Emitter {
  #saveTimer = null;

  constructor(storage) {
    super();
    this.storage = storage;
    this.conversations = this.#loadConversations();
    const savedActive = storage.load(STORAGE_KEYS.activeId, null);
    this.activeId = this.conversations.some((c) => c.id === savedActive) ? savedActive : null;
    this.saveFailed = false;
  }

  #loadConversations() {
    const data = this.storage.load(STORAGE_KEYS.conversations, []);
    if (!Array.isArray(data)) return [];
    return data
      .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages))
      .map((c) => ({
        title: 'New conversation',
        titleLocked: false,
        folderId: null,
        personalityId: null,
        ...c,
        // A reply that was streaming when the page closed can't be resumed.
        messages: c.messages
          .filter((m) => m && typeof m.content === 'string')
          .map((m) => (Array.isArray(m.attachments) ? m : { ...m, attachments: [] }))
          .map((m) => (m.status === 'streaming' ? { ...m, status: 'interrupted' } : m))
          .filter((m) => !(m.role === 'assistant' && m.status === 'interrupted' && !m.content)),
      }));
  }

  // ── persistence ──────────────────────────────────────────
  scheduleSave(delay = 300) {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.flush(), delay);
  }

  flush() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    const ok = this.storage.save(STORAGE_KEYS.conversations, this.conversations);
    this.storage.save(STORAGE_KEYS.activeId, this.activeId);
    if (!ok && !this.saveFailed) this.emit('save-error');
    this.saveFailed = !ok;
    return ok;
  }

  #changed(type, extra = {}, { saveDelay = 0 } = {}) {
    if (saveDelay) this.scheduleSave(saveDelay);
    else this.flush();
    this.emit('change', { type, ...extra });
  }

  // ── queries ──────────────────────────────────────────────
  list() {
    return [...this.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.conversations.find((c) => c.id === id) || null;
  }

  get active() {
    return this.get(this.activeId);
  }

  /** Searches titles and message text. Returns [{ conversation, snippet }]. */
  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.list().map((conversation) => ({ conversation, snippet: null }));
    const results = [];
    for (const c of this.list()) {
      if (c.title.toLowerCase().includes(q)) {
        results.push({ conversation: c, snippet: null });
        continue;
      }
      const hit = c.messages.find((m) => m.role !== 'notice' && m.content.toLowerCase().includes(q));
      if (hit) {
        const i = hit.content.toLowerCase().indexOf(q);
        const start = Math.max(0, i - 24);
        const snippet = `${start > 0 ? '…' : ''}${hit.content.slice(start, i + q.length + 40).replace(/\s+/g, ' ')}`;
        results.push({ conversation: c, snippet });
      }
    }
    return results;
  }

  stats() {
    const messages = this.conversations.reduce((n, c) => n + c.messages.filter((m) => m.role !== 'notice').length, 0);
    return {
      conversations: this.conversations.length,
      messages,
      bytes: this.storage.usage([STORAGE_KEYS.conversations, STORAGE_KEYS.settings, STORAGE_KEYS.activeId]),
      persistent: this.storage.available,
    };
  }

  // ── conversation mutations ──────────────────────────────
  create() {
    const now = Date.now();
    const conv = {
      id: uid(),
      title: 'New conversation',
      titleLocked: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
      folderId: null,
      personalityId: null,
    };
    this.conversations.push(conv);
    this.activeId = conv.id;
    this.#changed('create', { id: conv.id });
    return conv;
  }

  setActive(id) {
    const next = id && this.get(id) ? id : null;
    if (next === this.activeId) return;
    this.activeId = next;
    this.#changed('active', { id: next });
  }

  rename(id, title) {
    const c = this.get(id);
    const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!c || !t || t === c.title) return false;
    c.title = t;
    c.titleLocked = true;
    this.#changed('rename', { id });
    return true;
  }

  delete(id) {
    const i = this.conversations.findIndex((c) => c.id === id);
    if (i === -1) return;
    this.conversations.splice(i, 1);
    if (this.activeId === id) this.activeId = null;
    this.#changed('delete', { id });
  }

  clearAll() {
    this.conversations = [];
    this.activeId = null;
    this.#changed('clear');
  }

  // ── message mutations ───────────────────────────────────
  addMessage(convId, data) {
    const c = this.get(convId);
    if (!c) return null;
    const msg = {
      id: uid(),
      createdAt: Date.now(),
      status: 'complete',
      attachments: [],
      ...data,
    };
    c.messages.push(msg);
    c.updatedAt = msg.createdAt;
    if (msg.role === 'user' && !c.titleLocked && c.messages.filter((m) => m.role === 'user').length === 1) {
      c.title = msg.content.trim() ? makeTitle(msg.content) : msg.attachments.length ? 'Image conversation' : 'New conversation';
    }
    this.#changed('message-add', { id: convId, messageId: msg.id });
    return msg;
  }

  /** Updates a message. Use { stream: true } during streaming to avoid saving every token. */
  updateMessage(convId, msgId, patch, { stream = false } = {}) {
    const c = this.get(convId);
    const m = c?.messages.find((x) => x.id === msgId);
    if (!m) return null;
    Object.assign(m, patch);
    if (!stream) c.updatedAt = Date.now();
    this.#changed('message-update', { id: convId, messageId: msgId, stream }, { saveDelay: stream ? 800 : 0 });
    return m;
  }

  removeMessage(convId, msgId) {
    const c = this.get(convId);
    if (!c) return;
    const i = c.messages.findIndex((m) => m.id === msgId);
    if (i === -1) return;
    c.messages.splice(i, 1);
    this.#changed('message-remove', { id: convId, messageId: msgId });
  }

  /** Removes the given message and everything after it. */
  truncateFrom(convId, msgId) {
    const c = this.get(convId);
    if (!c) return;
    const i = c.messages.findIndex((m) => m.id === msgId);
    if (i === -1) return;
    c.messages.splice(i);
    this.#changed('message-remove', { id: convId });
  }

  /** IDs of stored images used by one conversation (or all of them). */
  attachmentIds(convId = null) {
    const list = convId ? [this.get(convId)].filter(Boolean) : this.conversations;
    return list.flatMap((c) => c.messages.flatMap((m) => (m.attachments || []).map((a) => a.id))).filter(Boolean);
  }

  /** IDs of images used by messages from `msgId` onward (for regenerate/truncate cleanup). */
  attachmentIdsFrom(convId, msgId) {
    const c = this.get(convId);
    const i = c ? c.messages.findIndex((m) => m.id === msgId) : -1;
    if (i === -1) return [];
    return c.messages.slice(i).flatMap((m) => (m.attachments || []).map((a) => a.id));
  }

  // ── export ──────────────────────────────────────────────
  exportJSON(ids = null) {
    const list = ids ? this.conversations.filter((c) => ids.includes(c.id)) : this.list();
    return JSON.stringify(
      {
        app: 'Drone Hive AI',
        format: 'dhai-conversations',
        version: 1,
        exportedAt: new Date().toISOString(),
        conversations: list,
      },
      null,
      2,
    );
  }

  exportMarkdown(id) {
    const c = this.get(id);
    if (!c) return '';
    const lines = [`# ${c.title}`, '', `_Exported from Drone Hive AI · ${new Date().toLocaleString()}_`, ''];
    for (const m of c.messages) {
      if (m.role === 'notice') continue;
      const imgs = (m.attachments || []).map((a) => `_[Image: ${a.name || 'image'}]_`);
      lines.push(`## ${m.role === 'user' ? 'You' : 'Drone Hive AI'}`, `_${new Date(m.createdAt).toLocaleString()}_`, '', ...imgs, m.content, '');
    }
    return lines.join('\n');
  }
}

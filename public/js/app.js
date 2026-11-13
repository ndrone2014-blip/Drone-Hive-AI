import { LocalStorageAdapter } from './core/storage.js';
import { SettingsStore } from './core/settings-store.js';
import { ConversationStore } from './core/conversation-store.js';
import { MemoryStore } from './core/memory-store.js';
import { ConnectionService } from './services/connection.js';
import { AuthService } from './services/auth.js';
import { AuthGate } from './ui/auth-gate.js';
import { sendChat, AIClientError } from './services/ai-client.js';
import { Sidebar } from './ui/sidebar.js';
import { ChatView } from './ui/chat-view.js';
import { Composer } from './ui/composer.js';
import { SettingsModal } from './ui/settings-modal.js';
import { ModelPicker, modelPillHTML } from './ui/model-picker.js';
import { $, downloadFile, slugify } from './ui/dom.js';
import { toast, confirmDialog, closeMenu } from './ui/overlays.js';
import { uid } from './core/conversation-store.js';
import { putAttachment, attachmentBase64, deleteAttachments, clearAttachments, pruneAttachments } from './core/attachments.js';
import { LIMITS } from './config.js';
import { initViewport } from './ui/viewport.js';

/** How many recent messages may carry their images to the AI (server also caps this). */
const IMAGE_HISTORY_MESSAGES = 6;

const formatReset = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today at ${time}`;
  // Weekly/monthly resets can be more than a week away: include the date then.
  const farAway = d.getTime() - Date.now() > 6 * 24 * 3600 * 1000;
  return `${d.toLocaleDateString([], farAway ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'long' })} at ${time}`;
};

const NOTICE_TEXT = {
  disconnected:
    'Your message was saved, but Drone Hive AI can’t reply until an AI provider is connected. Add an API key to the server’s environment variables (see Settings → AI Configuration), then try again.',
  auth:
    'Your message was saved, but you need to sign in again before Drone Hive AI can reply. Sign in, then press Try again.',
  offline:
    'Your message was saved, but the Drone Hive AI server isn’t running at this address. Start it with “npm start” on your PC or open your Netlify site, then try again.',
};

/**
 * App controller: wires the stores, services and UI together and owns the
 * send / stop / regenerate flow.
 */
export class App {
  constructor() {
    const storage = new LocalStorageAdapter();
    this.settings = new SettingsStore(storage);
    this.store = new ConversationStore(storage);
    this.connection = new ConnectionService();
    this.auth = new AuthService();
    this.authGate = new AuthGate({ auth: this.auth });
    this.memory = new MemoryStore({ storage, settings: this.settings, getToken: () => this.auth.getToken() });

    this.sending = null; // { convId, msgId, controller }
    this.quota = null; // latest usage summary from the server
    this.pendingWrites = Promise.resolve(); // image saves in progress
    initViewport();
    $('#model-pill').innerHTML = modelPillHTML();

    this.sidebar = new Sidebar({
      store: this.store,
      settings: this.settings,
      actions: {
        select: (id) => this.selectConversation(id),
        newChat: () => this.newChat(),
        rename: (id, title) => this.store.rename(id, title),
        delete: (id) => this.deleteConversation(id),
        exportMarkdown: (id) => this.exportMarkdown(id),
        openSettings: (section, focusKey) => this.settingsModal.open(section, focusKey),
      },
    });

    this.chat = new ChatView({
      store: this.store,
      settings: this.settings,
      connection: this.connection,
      actions: {
        usePrompt: (text) => this.composer.setValue(text, { focus: true }),
        regenerate: (msgId) => this.regenerate(msgId),
        retry: (msgId) => this.retry(msgId),
        editAndResend: (msgId, text) => this.editAndResend(msgId, text),
        canEdit: () => !this.sending,
        openSettings: (section) => this.settingsModal.open(section),
        openModelPicker: () => this.picker.open(),
      },
    });

    this.picker = new ModelPicker({
      settings: this.settings,
      connection: this.connection,
      actions: { openSettings: (section) => this.settingsModal.open(section) },
    });

    this.composer = new Composer({
      settings: this.settings,
      actions: {
        send: (text, attachments) => this.send(text, attachments),
        stop: () => this.stop(),
      },
    });

    this.settingsModal = new SettingsModal({
      settings: this.settings,
      store: this.store,
      connection: this.connection,
      auth: this.auth,
      memory: this.memory,
      getQuota: () => this.quota,
      actions: {
        refreshConnection: () => this.connection.refresh(),
        exportAll: () => this.exportAll(),
        deleteConversation: (id) => this.deleteConversation(id),
        clearAll: () => this.clearAll(),
        resetSettings: () => this.resetSettings(),
        signOut: () => this.signOut(),
        exportMemories: () => this.exportMemories(),
      },
    });

    this.#bindStores();
    this.#bindAuth();
    this.#bindGlobal();
    this.#applyAppearance();
    this.chat.render();
    this.#renderStatus();
    this.connection.refresh();
    this.composer.focus();
    // Tidy up images left behind by a crash or another tab, when the browser is idle.
    (window.requestIdleCallback || ((fn) => setTimeout(fn, 3000)))(() => pruneAttachments(this.store.attachmentIds()));
  }

  // ── store / service wiring ─────────────────────────────
  #bindStores() {
    this.store.on('change', (e) => {
      if (e.type === 'message-update' && e.stream) {
        this.chat.updateMessage(e.id, e.messageId);
        return;
      }
      this.chat.render();
      this.sidebar.render();
    });
    this.store.on('save-error', () =>
      toast('Browser storage is full — recent changes may not be saved. Export and delete old conversations in Settings.', { type: 'error', duration: 6000 }),
    );

    this.settings.on('change', ({ key }) => {
      if (['theme', 'fontSize', 'reduceMotion', '*'].includes(key)) this.#applyAppearance();
      if (['displayName', '*'].includes(key)) {
        this.sidebar.renderProfile();
        if (this.chat.main.classList.contains('is-welcome')) this.chat.render();
      }
      if (['showTimestamps', 'showProviderChip', '*'].includes(key)) this.chat.render();
      if (['enterToSend', '*'].includes(key)) this.composer.updateHint();
      if (['provider', 'model', '*'].includes(key)) this.#renderStatus();
      if (key === 'provider') {
        const label = this.picker.label();
        toast(this.settings.get('provider') === 'automatic' ? 'Automatic: Drone Hive AI will pick the best AI for each message.' : `Now using: ${label}`, { type: 'success' });
      }
    });

    this.connection.on('change', ({ status }) => {
      // The server tells us whether sign-in is required (and the public Firebase settings).
      if (status?.reachable) this.auth.init(status.auth);
      this.#syncMemory();
      this.#renderStatus();
      if (this.chat.main.classList.contains('is-welcome')) this.chat.render();
    });
  }

  #bindAuth() {
    this.auth.on('change', ({ state }) => {
      this.sidebar.setAccount(state === 'signed-in' ? this.auth.user : null);
      this.#syncMemory();
      if (state === 'signed-in') this.composer.focus();
    });
  }

  /**
   * Points the memory store at the right place: the signed-in account's
   * memories (or this browser's guest memories when sign-in is off). Waits
   * until the server has said whether sign-in is required, so memories are
   * never loaded for the wrong person.
   */
  #syncMemory() {
    const status = this.connection.status;
    if (!status?.reachable) return;
    const authRequired = Boolean(status.auth?.required);
    if (authRequired && this.auth.state === 'off') return; // sign-in still starting
    this.memory.configure({
      store: status.memory?.store || 'browser',
      authRequired,
      user: this.auth.signedIn ? this.auth.user : null,
    });
  }

  exportMemories() {
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(`drone-hive-ai-memories-${date}.json`, this.memory.exportJSON());
    toast('Memories downloaded', { type: 'success' });
  }

  async signOut() {
    const ok = await confirmDialog({ title: 'Sign out?', body: 'Your conversations stay saved in this browser.', confirmText: 'Sign out' });
    if (!ok) return;
    this.stop();
    try {
      await this.auth.signOut();
      this.settingsModal.close();
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }

  #bindGlobal() {

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.sidebar.focusSearch();
      } else if (e.key === 'Escape' && document.documentElement.classList.contains('sidebar-open')) {
        this.sidebar.closeMobile();
      } else if (e.key === 'Escape' && this.sending && !this.settingsModal.isOpen && !document.querySelector('.dialog-backdrop, .menu, .lightbox')) {
        this.stop();
      }
    });

    // Make sure the latest state is written before the tab closes.
    const flush = () => this.store.flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });

    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.settings.get('theme') === 'system') this.#applyAppearance();
    });
  }

  #applyAppearance() {
    const root = document.documentElement;
    let theme = this.settings.get('theme');
    if (theme === 'system') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.dataset.theme = theme;
    root.dataset.fontSize = this.settings.get('fontSize');
    root.classList.toggle('reduce-motion', Boolean(this.settings.get('reduceMotion')));
    root.classList.toggle('sidebar-collapsed', Boolean(this.settings.get('sidebarCollapsed')));
  }

  #renderStatus() {
    this.picker.render();
    // Image uploads are only offered when an AI that can see them is available.
    const { state, status } = this.connection;
    if (state !== 'connected') {
      this.composer.setImageSupport(false, state === 'checking' ? 'Checking which AIs are available…' : 'Image uploads need a connected AI provider.');
    } else if (!status?.vision) {
      this.composer.setImageSupport(false, 'None of the AI providers connected to Drone Hive AI can read images, so image uploads are turned off.');
    } else if (!this.picker.canSeeImages) {
      this.composer.setImageSupport(false, `${this.picker.label()} can’t read images. Switch to Automatic or Default in the AI menu to send images.`);
    } else {
      this.composer.setImageSupport(true);
    }
  }

  // ── conversations ──────────────────────────────────────
  newChat() {
    this.store.setActive(null);
    this.chat.render();
    this.sidebar.render();
    this.composer.focus();
  }

  selectConversation(id) {
    this.store.setActive(id);
    this.composer.focus();
  }

  async deleteConversation(id) {
    const c = this.store.get(id);
    if (!c) return;
    const ok = await confirmDialog({
      title: 'Delete conversation?',
      body: `“${c.title}” will be permanently deleted from this browser.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    if (this.sending?.convId === id) this.stop();
    const images = this.store.attachmentIds(id);
    this.store.delete(id);
    deleteAttachments(images);
    toast('Conversation deleted', { type: 'success' });
  }

  async clearAll() {
    const ok = await confirmDialog({
      title: 'Clear all chat history?',
      body: 'Every conversation in this browser will be permanently deleted. Export first if you want a backup.',
      confirmText: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    this.stop();
    this.store.clearAll();
    clearAttachments();
    toast('All conversations deleted', { type: 'success' });
  }

  async resetSettings() {
    const ok = await confirmDialog({ title: 'Reset all settings?', body: 'Your conversations will not be affected.', confirmText: 'Reset' });
    if (!ok) return;
    this.settings.reset();
    toast('Settings reset', { type: 'success' });
  }

  exportAll() {
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(`drone-hive-ai-conversations-${date}.json`, this.store.exportJSON());
    toast('Export downloaded', { type: 'success' });
  }

  exportMarkdown(id) {
    const c = this.store.get(id);
    if (!c) return;
    downloadFile(`${slugify(c.title)}.md`, this.store.exportMarkdown(id), 'text/markdown');
  }

  // ── messaging ─────────────────────────────────────────
  /** Returns false if the message was not accepted (so the composer keeps the text). */
  send(text, attachments = []) {
    const content = text.replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!content.trim() && !attachments.length) return false;
    if (this.sending) return false; // prevents duplicate sends
    closeMenu();
    const refs = attachments.slice(0, LIMITS.maxImagesPerMessage).map(({ blob, meta }) => {
      const id = `img-${uid()}`;
      this.pendingWrites = this.pendingWrites.then(() => putAttachment(id, blob));
      return { id, ...meta };
    });
    const conv = this.store.active || this.store.create();
    this.store.addMessage(conv.id, { role: 'user', content, attachments: refs });
    this.chat.scrollToBottom(false);
    this.#requestReply(conv.id);
    return true;
  }

  stop() {
    this.sending?.controller.abort();
  }

  regenerate(msgId) {
    if (this.sending) return;
    const conv = this.store.active;
    if (!conv) return;
    this.store.truncateFrom(conv.id, msgId);
    if (conv.messages.at(-1)?.role === 'user') this.#requestReply(conv.id);
  }

  /** Replaces the last user message with an edited version and asks again. */
  editAndResend(msgId, text) {
    if (this.sending) return false;
    const conv = this.store.active;
    const msg = conv?.messages.find((m) => m.id === msgId);
    const content = String(text || '').replace(/\s+$/, '');
    if (!msg || msg.role !== 'user' || (!content.trim() && !msg.attachments?.length)) return false;
    if (content.length > LIMITS.maxMessageChars) {
      toast(`Messages can be up to ${LIMITS.maxMessageChars.toLocaleString()} characters.`, { type: 'error' });
      return false;
    }
    const attachments = msg.attachments || [];
    this.store.truncateFrom(conv.id, msgId);
    this.store.addMessage(conv.id, { role: 'user', content, attachments });
    this.chat.scrollToBottom(false);
    this.#requestReply(conv.id);
    return true;
  }

  retry(noticeId) {
    if (this.sending) return;
    const conv = this.store.active;
    if (!conv) return;
    this.store.removeMessage(conv.id, noticeId);
    if (conv.messages.at(-1)?.role === 'user') this.#requestReply(conv.id);
  }

  async #requestReply(convId) {
    const conv = this.store.get(convId);
    if (!conv || this.sending) return;

    const placeholder = this.store.addMessage(convId, { role: 'assistant', content: '', status: 'streaming' });
    const controller = new AbortController();
    this.sending = { convId, msgId: placeholder.id, controller };
    this.composer.setBusy(true);

    const s = this.settings.all();
    let content = '';
    let meta = {};
    try {
      const history = await this.#buildHistory(conv, placeholder.id);
      // If we already know no AI is reachable, re-check status (cheap, always 200)
      // instead of sending a request we know will fail.
      if (this.connection.state === 'disconnected' || this.connection.state === 'offline') {
        await this.connection.refresh();
        if (this.connection.state === 'disconnected') throw new AIClientError('PROVIDER_NOT_CONFIGURED', 'No AI provider connected.');
        if (this.connection.state === 'offline') throw new AIClientError('BACKEND_UNAVAILABLE', 'Server not reachable.');
      }
      const result = await sendChat({
        messages: history,
        provider: this.picker.choice,
        model: s.model || undefined,
        options: {
          temperature: s.temperature ?? undefined,
          responseLength: s.responseLength || 'medium',
          customInstructions: s.customInstructions || undefined,
          // Which AI wrote the last reply here, so Automatic can stay with it
          // when it's still a good fit (avoids switching AIs mid-chat).
          lastProvider: [...conv.messages].reverse().find((m) => m.role === 'assistant' && m.meta?.provider)?.meta?.provider || undefined,
        },
        memory: this.memory.forRequest({
          recentTitles: this.store
            .list()
            .filter((c) => c.id !== convId && c.messages.some((m) => m.role === 'user'))
            .map((c) => c.title),
        }),
        stream: s.streamResponses,
        accessCode: (s.accessCode || '').trim() || undefined,
        authToken: this.auth.required ? (await this.auth.getToken()) || undefined : undefined,
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === 'routing') {
            meta = { routing: ev.mode };
            this.store.updateMessage(convId, placeholder.id, { meta }, { stream: true });
          }
          if (ev.type === 'start') {
            meta = { provider: ev.provider?.id, providerName: ev.provider?.shortName || ev.provider?.name, model: ev.model, mode: ev.mode, rerouted: Boolean(ev.rerouted) };
            this.store.updateMessage(convId, placeholder.id, { meta }, { stream: true });
          }
          if (ev.type === 'done' && ev.quota) this.quota = ev.quota;
          if (ev.type === 'memory') {
            const summary = this.memory.applyChatEvent(ev);
            if (summary && (summary.applied.length || summary.rejected.length || summary.error)) {
              meta = { ...meta, memory: summary };
              this.store.updateMessage(convId, placeholder.id, { meta }, { stream: true });
            }
          }
          if (ev.type === 'delta') {
            content += ev.text;
            this.store.updateMessage(convId, placeholder.id, { content, meta }, { stream: true });
          }
        },
      });
      content = result.content;
      if (!content.trim()) {
        this.store.removeMessage(convId, placeholder.id);
        this.store.addMessage(convId, { role: 'notice', variant: 'error', content: 'The AI returned an empty response. Try again or rephrase your message.' });
      } else {
        this.store.updateMessage(convId, placeholder.id, {
          content,
          status: 'complete',
          meta: { ...meta, usage: result.usage, stopReason: result.stopReason },
        });
      }
      if (this.connection.state !== 'connected') this.connection.refresh();
    } catch (err) {
      const partial = err?.partial ?? content;
      if (err?.name === 'AbortError') {
        if (partial) this.store.updateMessage(convId, placeholder.id, { content: partial, status: 'stopped', meta });
        else this.store.removeMessage(convId, placeholder.id);
      } else {
        if (partial) this.store.updateMessage(convId, placeholder.id, { content: partial, status: 'interrupted', meta });
        else this.store.removeMessage(convId, placeholder.id);
        const code = err?.code || 'UNKNOWN';
        const authCode = ['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(code);
        if (code === 'DUPLICATE_REQUEST') {
          toast('That message is already being answered.');
          return;
        }
        const variant =
          code === 'PROVIDER_NOT_CONFIGURED' && this.connection.state !== 'connected' ? 'disconnected'
          : code === 'BACKEND_UNAVAILABLE' ? 'offline'
          : authCode ? 'auth'
          : ['USAGE_LIMIT', 'GLOBAL_LIMIT', 'SERVICE_PAUSED'].includes(code) ? 'limit'
          : ['ALL_PROVIDERS_FAILED', 'RATE_LIMITED'].includes(code) ? 'busy'
          : ['VISION_UNSUPPORTED', 'INVALID_IMAGE'].includes(code) ? 'image'
          : 'error';
        let text = NOTICE_TEXT[variant] || err?.message || 'Something went wrong while getting a reply.';
        if (variant === 'limit' && err?.resetAt && code !== 'SERVICE_PAUSED') {
          const when = formatReset(err.resetAt);
          if (when) text = `${text.replace(/ ?(Your usage resets every day at midnight UTC\.|Your weekly allowance resets every Monday at midnight UTC\.|Your monthly allowance resets on the 1st at midnight UTC\.|It resets every Monday at midnight UTC\.|It resets on [^.]+ at midnight UTC\.|New messages will work again after the daily reset at midnight UTC\.|You can send more after the hour resets\.)/, '')} You can send messages again ${when}.`;
        }
        this.store.addMessage(convId, { role: 'notice', variant, content: text, meta: { code } });
        this.connection.markFromError(code);
        // Server says sign-in is needed (e.g. it was just turned on): re-check status to show the sign-in screen.
        if (authCode || code === 'EMAIL_NOT_VERIFIED') this.connection.refresh();
        if (code !== 'PROVIDER_NOT_CONFIGURED' && code !== 'BACKEND_UNAVAILABLE') console.warn('[Drone Hive AI]', code, err?.message);
      }
    } finally {
      this.sending = null;
      this.composer.setBusy(false);
    }
  }

  /**
   * Turns the conversation into the request format. Only real user/assistant
   * turns go to the AI — never app notices. Images from the most recent
   * messages are loaded from this browser's storage and attached.
   */
  async #buildHistory(conv, placeholderId) {
    await this.pendingWrites;
    const turns = conv.messages.filter(
      (m) => m.id !== placeholderId && (m.role === 'user' || (m.role === 'assistant' && m.content && m.status !== 'streaming')),
    );
    const firstWithImages = Math.max(0, turns.length - IMAGE_HISTORY_MESSAGES);
    return Promise.all(
      turns.map(async (m, i) => {
        const atts = m.role === 'user' && i >= firstWithImages ? (m.attachments || []).filter((a) => a.kind === 'image') : [];
        if (!atts.length) {
          const note = m.attachments?.length ? `${m.content}${m.content ? '\n\n' : ''}[Image shared earlier]` : m.content;
          return { role: m.role, content: note };
        }
        const images = (await Promise.all(atts.map((a) => attachmentBase64(a.id)))).filter(Boolean);
        const missing = atts.length - images.length;
        const text = missing ? `${m.content}${m.content ? '\n\n' : ''}[${missing} image(s) no longer available on this device]` : m.content;
        return {
          role: 'user',
          content: [...(text ? [{ type: 'text', text }] : []), ...images.map((img) => ({ type: 'image', mediaType: img.mediaType, data: img.data }))],
        };
      }),
    );
  }
}

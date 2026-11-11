import { LocalStorageAdapter } from './core/storage.js';
import { SettingsStore } from './core/settings-store.js';
import { ConversationStore } from './core/conversation-store.js';
import { ConnectionService } from './services/connection.js';
import { sendChat, AIClientError } from './services/ai-client.js';
import { Sidebar } from './ui/sidebar.js';
import { ChatView } from './ui/chat-view.js';
import { Composer } from './ui/composer.js';
import { SettingsModal } from './ui/settings-modal.js';
import { $, downloadFile, slugify } from './ui/dom.js';
import { toast, confirmDialog } from './ui/overlays.js';

const NOTICE_TEXT = {
  disconnected:
    'Your message was saved, but Drone Hive AI can’t reply until an AI provider is connected. Add an API key to the server’s environment variables (see Settings → AI Configuration), then try again.',
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

    this.sending = null; // { convId, msgId, controller }

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
        openSettings: (section) => this.settingsModal.open(section),
      },
    });

    this.composer = new Composer({
      settings: this.settings,
      actions: {
        send: (text) => this.send(text),
        stop: () => this.stop(),
      },
    });

    this.settingsModal = new SettingsModal({
      settings: this.settings,
      store: this.store,
      connection: this.connection,
      actions: {
        refreshConnection: () => this.connection.refresh(),
        exportAll: () => this.exportAll(),
        deleteConversation: (id) => this.deleteConversation(id),
        clearAll: () => this.clearAll(),
        resetSettings: () => this.resetSettings(),
      },
    });

    this.#bindStores();
    this.#bindGlobal();
    this.#applyAppearance();
    this.chat.render();
    this.#renderStatus();
    this.connection.refresh();
    this.composer.focus();
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
      if (['showTimestamps', '*'].includes(key)) this.chat.render();
      if (['enterToSend', '*'].includes(key)) this.composer.updateHint();
      if (['provider', 'model', '*'].includes(key)) this.#renderStatus();
    });

    this.connection.on('change', () => {
      this.#renderStatus();
      if (this.chat.main.classList.contains('is-welcome')) this.chat.render();
    });
  }

  #bindGlobal() {
    $('#status-pill').addEventListener('click', () => this.settingsModal.open('ai'));

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.sidebar.focusSearch();
      } else if (e.key === 'Escape' && this.sending && !this.settingsModal.isOpen && !document.querySelector('.dialog-backdrop, .menu')) {
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
    const pill = $('#status-pill');
    const { state } = this.connection;
    const s = this.settings.all();
    const provider = this.connection.providers.find((p) => p.id === s.provider && p.configured) || this.connection.activeProvider;
    const model = provider?.models.includes(s.model) ? s.model : provider?.defaultModel;
    const labels = {
      checking: 'Checking…',
      connected: model || provider?.name || 'Connected',
      disconnected: 'AI not connected',
      offline: 'Server offline',
    };
    pill.dataset.state = state;
    pill.querySelector('.status-label').textContent = labels[state];
    pill.title = state === 'connected' ? `Connected to ${provider?.name}` : 'Open AI settings';
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
    this.store.delete(id);
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
  send(text) {
    const content = text.replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (!content.trim()) return false;
    if (this.sending) return false; // prevents duplicate sends
    const conv = this.store.active || this.store.create();
    this.store.addMessage(conv.id, { role: 'user', content });
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

    // Only real user/assistant turns go to the AI — never app notices.
    const history = conv.messages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content && m.status !== 'streaming'))
      .map((m) => ({ role: m.role, content: m.content }));

    const placeholder = this.store.addMessage(convId, { role: 'assistant', content: '', status: 'streaming' });
    const controller = new AbortController();
    this.sending = { convId, msgId: placeholder.id, controller };
    this.composer.setBusy(true);

    const s = this.settings.all();
    let content = '';
    let meta = {};
    try {
      // If we already know no AI is reachable, re-check status (cheap, always 200)
      // instead of sending a request we know will fail.
      if (this.connection.state === 'disconnected' || this.connection.state === 'offline') {
        await this.connection.refresh();
        if (this.connection.state === 'disconnected') throw new AIClientError('PROVIDER_NOT_CONFIGURED', 'No AI provider connected.');
        if (this.connection.state === 'offline') throw new AIClientError('BACKEND_UNAVAILABLE', 'Server not reachable.');
      }
      const result = await sendChat({
        messages: history,
        provider: s.provider,
        model: s.model || undefined,
        options: {
          temperature: s.temperature ?? undefined,
          maxTokens: s.maxTokens ?? undefined,
          customInstructions: s.customInstructions || undefined,
        },
        stream: s.streamResponses,
        accessCode: s.accessCode || undefined,
        signal: controller.signal,
        onEvent: (ev) => {
          if (ev.type === 'start') meta = { provider: ev.provider?.id, model: ev.model };
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
          meta: { provider: result.provider?.id, model: result.model, usage: result.usage, stopReason: result.stopReason },
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
        const variant = code === 'PROVIDER_NOT_CONFIGURED' ? 'disconnected' : code === 'BACKEND_UNAVAILABLE' ? 'offline' : 'error';
        this.store.addMessage(convId, {
          role: 'notice',
          variant,
          content: NOTICE_TEXT[variant] || err?.message || 'Something went wrong while getting a reply.',
          meta: { code },
        });
        this.connection.markFromError(code);
        if (code !== 'PROVIDER_NOT_CONFIGURED' && code !== 'BACKEND_UNAVAILABLE') console.warn('[Drone Hive AI]', code, err?.message);
      }
    } finally {
      this.sending = null;
      this.composer.setBusy(false);
    }
  }
}

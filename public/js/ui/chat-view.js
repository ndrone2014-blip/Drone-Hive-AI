import { $, escapeHtml, formatDateTime, copyText } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { toast, showImage } from './overlays.js';
import { SUGGESTED_PROMPTS, LIMITS } from '../config.js';
import { attachmentUrl } from '../core/attachments.js';

const NEAR_BOTTOM = 140;

/**
 * Main chat area: welcome screen and message list.
 */
export class ChatView {
  constructor({ store, settings, connection, actions }) {
    this.store = store;
    this.settings = settings;
    this.connection = connection;
    this.actions = actions; // { usePrompt, regenerate, retry, openSettings }
    this.main = $('#main');
    this.scroller = $('#chat-scroll');
    this.content = $('#chat-content');
    this.scrollBtn = $('#scroll-bottom');
    this.scrollBtn.innerHTML = icon('arrowDown');
    this.renderedId = undefined;
    this.pendingFrame = null;
    this.stickToBottom = true;
    this.seen = new Set(); // message ids already shown (only new ones animate in)
    this.editingId = null; // user message being edited in place

    this.scroller.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    this.scrollBtn.addEventListener('click', () => this.scrollToBottom(true));
    this.content.addEventListener('click', (e) => this.#onClick(e));
    this.content.addEventListener('keydown', (e) => this.#onEditKey(e));
    this.content.addEventListener('input', (e) => {
      if (e.target.classList.contains('edit-input')) {
        this.editDraft = e.target.value; // survives a re-render while editing
        this.#autoGrow(e.target);
      }
    });
  }

  // ── rendering ──────────────────────────────────────────
  render() {
    const conv = this.store.active;
    const isWelcome = !conv || conv.messages.length === 0;
    this.main.classList.toggle('is-welcome', isWelcome);
    $('#topbar-title').textContent = conv && !isWelcome ? conv.title : 'New conversation';
    document.title = conv && !isWelcome ? `${conv.title} · Drone Hive AI` : 'Drone Hive AI';

    if (isWelcome) {
      this.content.innerHTML = this.#welcomeHTML();
      this.renderedId = null;
      this.scrollBtn.hidden = true;
      return;
    }
    const switched = this.renderedId !== conv.id;
    if (switched) {
      this.seen = new Set(conv.messages.map((m) => m.id));
      this.editingId = null;
    }
    const lastUserIndex = conv.messages.findLastIndex((m) => m.role === 'user');
    this.content.innerHTML = `<div class="messages">${conv.messages.map((m, i) => this.#messageHTML(m, i === this.#lastAssistantIndex(conv), i === conv.messages.length - 1, i === lastUserIndex)).join('')}</div>`;
    this.renderedId = conv.id;
    conv.messages.forEach((m) => this.seen.add(m.id));
    this.#hydrateImages();
    const editor = this.content.querySelector('.edit-input');
    if (editor) {
      this.#autoGrow(editor);
      if (!editor.dataset.focused) {
        editor.dataset.focused = '1';
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
      }
    }
    if (switched) {
      this.stickToBottom = true;
      this.scrollToBottom(false);
    } else if (this.stickToBottom && this.settings.get('autoScroll')) {
      this.scrollToBottom(false);
    }
  }

  /** Re-renders a single message (used while streaming, batched per frame). */
  updateMessage(convId, msgId) {
    if (convId !== this.renderedId) return;
    if (this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = null;
      const conv = this.store.get(convId);
      const msg = conv?.messages.find((m) => m.id === msgId);
      const el = this.content.querySelector(`[data-msg="${msgId}"]`);
      if (!msg || !el) return this.render();
      // Only swap the bubble's contents so the element (and its animation) stays put.
      const bubble = el.querySelector('.bubble-ai');
      if (bubble) bubble.innerHTML = this.#aiContentHTML(msg);
      const head = el.querySelector('.ai-head');
      if (head) {
        const next = this.#headHTML(msg);
        if (head.innerHTML !== next) head.innerHTML = next;
      }
      if (this.stickToBottom && this.settings.get('autoScroll')) this.scrollToBottom(false);
    });
  }

  #lastAssistantIndex(conv) {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'assistant') return i;
      if (conv.messages[i].role === 'user') return -1;
    }
    return -1;
  }

  #welcomeHTML() {
    const name = this.settings.get('displayName').trim().split(/\s+/)[0];
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const state = this.connection.state;
    let notice = '';
    if (state === 'disconnected') {
      notice = `<button type="button" class="welcome-notice" data-action="open-ai-settings">${icon('plug', { size: 15 })}<span><b>AI not connected yet.</b> Your chats are saved, but replies need an API key on the server. <u>Set it up</u></span></button>`;
    } else if (state === 'offline') {
      notice = `<button type="button" class="welcome-notice" data-action="open-ai-settings">${icon('alert', { size: 15 })}<span><b>Server not reachable.</b> Run the app with <code>npm start</code> or deploy to Netlify to enable AI. <u>Details</u></span></button>`;
    }
    return `
      <div class="welcome">
        <div class="welcome-mark" aria-hidden="true"><span class="logo-tile logo-tile-xl"><img class="logo-ink" src="/assets/brand/emblem.png" alt="" width="576" height="586"></span></div>
        <p class="welcome-eyebrow">${greet}${name ? `, ${escapeHtml(name)}` : ''}</p>
        <h2 class="welcome-title">What are we building today?</h2>
        <p class="welcome-sub">Drone Hive AI helps you write code, untangle ideas and get things done — built by Drone Hive Studios.</p>
        <div class="prompt-grid">
          ${SUGGESTED_PROMPTS.map(
            (p, i) => `<button type="button" class="prompt-card" data-action="prompt" data-i="${i}">
              <span class="prompt-icon">${icon(p.icon, { size: 18 })}</span>
              <span class="prompt-text"><span class="prompt-title">${escapeHtml(p.title)}</span><span class="prompt-sub">${escapeHtml(p.subtitle)}</span></span>
            </button>`,
          ).join('')}
        </div>
        ${notice}
      </div>`;
  }

  #messageHTML(m, isLastAssistant, isLast, isLastUser = false) {
    const enter = this.seen.has(m.id) ? '' : ' enter';
    const time = this.settings.get('showTimestamps') ? `<time datetime="${new Date(m.createdAt).toISOString()}">${formatDateTime(m.createdAt)}</time>` : '';

    if (m.role === 'user') {
      const atts = (m.attachments || []).filter((a) => a.kind === 'image');
      const images = atts.length
        ? `<div class="msg-images count-${Math.min(atts.length, 4)}">${atts
            .map(
              (a) => `<button type="button" class="msg-image" data-action="view-image" data-att="${escapeHtml(a.id)}" aria-label="View image ${escapeHtml(a.name || '')}" data-ratio="${Number(a.width) || 4}/${Number(a.height) || 3}">
                <img data-att="${escapeHtml(a.id)}" alt="${escapeHtml(a.name || 'Attached image')}" width="${Number(a.width) || ''}" height="${Number(a.height) || ''}">
              </button>`,
            )
            .join('')}</div>`
        : '';
      if (this.editingId === m.id) {
        return `<article class="msg msg-user is-editing" data-msg="${m.id}">
          ${images}
          <div class="edit-box">
            <textarea class="edit-input" rows="1" aria-label="Edit your message" maxlength="${LIMITS.maxMessageChars}">${escapeHtml(this.editDraft ?? m.content)}</textarea>
            <div class="edit-actions">
              <span class="edit-hint">Sending replaces the reply below.</span>
              <button type="button" class="btn btn-sm btn-ghost" data-action="edit-cancel">Cancel</button>
              <button type="button" class="btn btn-sm btn-primary" data-action="edit-save">${icon('send', { size: 14 })}<span>Send</span></button>
            </div>
          </div>
        </article>`;
      }
      return `<article class="msg msg-user${enter}" data-msg="${m.id}">
        ${images}
        ${m.content ? `<div class="bubble bubble-user">${escapeHtml(m.content)}</div>` : ''}
        <div class="msg-actions">
          ${time}
          <button type="button" class="act" data-action="copy" title="Copy message" aria-label="Copy message">${icon('copy', { size: 15 })}</button>
          ${isLastUser && m.content ? `<button type="button" class="act" data-action="edit" title="Edit message" aria-label="Edit message">${icon('pencil', { size: 15 })}</button>` : ''}
        </div>
      </article>`;
    }

    if (m.role === 'notice') return this.#noticeHTML(m, time, isLast, enter);

    // assistant
    const streaming = m.status === 'streaming';
    const body = this.#aiContentHTML(m);
    return `<article class="msg msg-ai${streaming ? ' is-streaming' : ''}${enter}" data-msg="${m.id}">
      <div class="ai-avatar logo-tile" aria-hidden="true"><img class="logo-ink" src="/assets/brand/emblem.png" alt="" width="576" height="586"></div>
      <div class="ai-body">
        <div class="ai-head">${this.#headHTML(m)}</div>
        <div class="bubble bubble-ai">${body}</div>
        ${streaming ? '' : `<div class="msg-actions">
          ${time}
          <button type="button" class="act" data-action="copy" title="Copy response" aria-label="Copy response">${icon('copy', { size: 15 })}</button>
          ${isLastAssistant ? `<button type="button" class="act" data-action="regenerate" title="Regenerate response" aria-label="Regenerate response">${icon('refresh', { size: 15 })}</button>` : ''}
        </div>`}
      </div>
    </article>`;
  }

  /**
   * Name, plus small chips: "Memory updated" when this reply saved something,
   * and (only if turned on in AI settings) which provider actually answered.
   */
  #headHTML(m) {
    const tag =
      m.status === 'stopped' ? '<span class="msg-tag">Stopped</span>' : m.status === 'interrupted' ? '<span class="msg-tag">Interrupted</span>' : '';
    const meta = m.meta || {};
    let chip = '';
    if (this.settings.get('showProviderChip') && (meta.providerName || meta.model)) {
      const name = meta.providerName || meta.model;
      const tip = [
        meta.providerName ? `Answered by ${meta.providerName}` : '',
        meta.model ? `Model: ${meta.model}` : '',
        meta.mode === 'automatic' ? 'Picked automatically' : '',
        meta.rerouted ? 'The first-choice AI was busy, so another one answered' : '',
      ].filter(Boolean).join(' · ');
      chip = `<span class="msg-provider" title="${escapeHtml(tip)}">${meta.mode === 'automatic' ? icon('sparkle', { size: 12 }) : ''}<span>${escapeHtml(name)}</span>${meta.rerouted ? '<i aria-hidden="true">↻</i>' : ''}</span>`;
    }
    return `<span class="ai-head-mark logo-tile" aria-hidden="true"><img class="logo-ink" src="/assets/brand/emblem.png" alt="" width="576" height="586"></span><span class="ai-name">Drone Hive AI</span>${this.#memoryChip(meta.memory)}${chip}${tag}`;
  }

  /** "Memory updated" / "Not saved" chip; opens Settings → Memory. */
  #memoryChip(mem) {
    if (!mem) return '';
    const applied = mem.applied || [];
    const rejected = mem.rejected || [];
    if (!applied.length && !rejected.length && !mem.error) return '';
    const verb = { add: 'Saved', update: 'Updated', delete: 'Forgot', clear: 'Cleared all memories' };
    const lines = [
      ...applied.map((a) => (a.op === 'clear' ? verb.clear : `${verb[a.op] || 'Saved'}: ${a.text}`)),
      ...rejected.map((r) => `Not saved: ${r.reason}`),
      ...(mem.error ? [mem.error] : []),
    ];
    const ok = applied.length > 0;
    const label = ok ? (applied.every((a) => a.op === 'delete') ? 'Memory removed' : 'Memory updated') : 'Memory not saved';
    return `<button type="button" class="msg-memory${ok ? '' : ' is-warn'}" data-action="open-memory" title="${escapeHtml(lines.join('\n'))}" aria-label="${escapeHtml(`${label}. ${lines.join('. ')}. Open memory settings`)}">${icon(ok ? 'brain' : 'alert', { size: 12 })}<span>${label}</span></button>`;
  }

  #aiContentHTML(m) {
    const streaming = m.status === 'streaming';
    if (m.content) {
      let body = renderMarkdown(m.content);
      if (streaming) {
        const caret = '<span class="caret" aria-hidden="true"></span>';
        const inlined = body.replace(/(<\/(?:p|li|h[2-5])>)((?:<\/(?:ul|ol)>)?)$/, `${caret}$1$2`);
        body = inlined === body ? body + caret : inlined;
      }
      return `<div class="md">${body}</div>`;
    }
    if (streaming) {
      const label = m.meta?.providerName ? 'Writing…' : 'Thinking…';
      return `<div class="thinking" role="status"><span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="thinking-label">${label}</span></div>`;
    }
    return '';
  }

  #noticeHTML(m, time, isLast, enter = '') {
    const v = m.variant || 'error';
    const ico = v === 'disconnected' ? 'plug' : v === 'auth' ? 'user' : v === 'limit' ? 'gauge' : v === 'image' ? 'image' : 'alert';
    const titles = {
      disconnected: 'AI provider not connected',
      offline: 'Server not reachable',
      auth: 'Sign in required',
      limit: m.meta?.code === 'GLOBAL_LIMIT' ? 'Daily capacity reached' : m.meta?.code === 'SERVICE_PAUSED' ? 'Temporarily paused' : 'Usage limit reached',
      busy: 'AI providers are busy',
      image: 'Image couldn’t be sent',
    };
    const title = titles[v] || 'Something went wrong';
    const canRetry = isLast && v !== 'limit';
    return `<article class="msg msg-notice notice-${v}${enter}" data-msg="${m.id}" role="status">
      <div class="notice-icon">${icon(ico, { size: 18 })}</div>
      <div class="notice-body">
        <div class="notice-title">${title}</div>
        <p>${escapeHtml(m.content)}</p>
        <div class="notice-actions">
          ${['disconnected', 'offline'].includes(v) || /access code/i.test(m.content) ? `<button type="button" class="btn btn-sm btn-secondary" data-action="open-ai-settings">${icon('settings', { size: 14 })}<span>AI settings</span></button>` : ''}
          ${v === 'image' ? `<button type="button" class="btn btn-sm btn-secondary" data-action="open-model-picker">${icon('sparkle', { size: 14 })}<span>Change AI</span></button>` : ''}
          ${canRetry ? `<button type="button" class="btn btn-sm btn-ghost" data-action="retry">${icon('refresh', { size: 14 })}<span>Try again</span></button>` : ''}
          ${time}
        </div>
      </div>
    </article>`;
  }

  // ── interaction ────────────────────────────────────────
  async #onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const msgEl = btn.closest('[data-msg]');
    const msgId = msgEl?.dataset.msg;

    if (action === 'prompt') return this.actions.usePrompt(SUGGESTED_PROMPTS[Number(btn.dataset.i)].prompt);
    if (action === 'open-ai-settings') return this.actions.openSettings('ai');
    if (action === 'open-memory') return this.actions.openSettings('memory');
    if (action === 'edit') {
      if (this.actions.canEdit && !this.actions.canEdit()) return toast('Wait for the current reply to finish, or stop it first.');
      this.editingId = msgId;
      this.editDraft = null;
      return this.render();
    }
    if (action === 'edit-cancel') {
      this.editingId = null;
      this.editDraft = null;
      return this.render();
    }
    if (action === 'edit-save') return this.#saveEdit(msgEl);
    if (action === 'open-model-picker') return this.actions.openModelPicker?.();
    if (action === 'view-image') {
      const img = btn.querySelector('img');
      if (img?.src) showImage(img.src, img.alt);
      return;
    }
    if (action === 'regenerate') return this.actions.regenerate(msgId);
    if (action === 'retry') return this.actions.retry(msgId);
    if (action === 'copy') {
      const msg = this.store.active?.messages.find((m) => m.id === msgId);
      if (msg && (await copyText(msg.content))) this.#flash(btn);
      else toast('Could not copy to clipboard', { type: 'error' });
    }
    if (action === 'copy-code') {
      const code = btn.closest('.code-block')?.querySelector('code')?.textContent || '';
      if (await copyText(code)) this.#flash(btn, true);
    }
  }

  #saveEdit(msgEl) {
    const input = msgEl?.querySelector('.edit-input');
    if (!input) return;
    const id = msgEl.dataset.msg;
    this.editingId = null;
    this.editDraft = null;
    if (!this.actions.editAndResend(id, input.value)) {
      this.editDraft = input.value;
      this.editingId = id;
      this.render();
    }
  }

  #onEditKey(e) {
    if (!e.target.classList?.contains('edit-input')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.editingId = null;
      this.editDraft = null;
      this.render();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (!e.shiftKey && this.settings.get('enterToSend') && !matchMedia('(pointer: coarse)').matches))) {
      e.preventDefault();
      this.#saveEdit(e.target.closest('[data-msg]'));
    }
  }

  #autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  /** Loads stored images into <img> tags (object URLs from IndexedDB). */
  async #hydrateImages() {
    // (Set through the DOM: the Content-Security-Policy forbids inline style attributes.)
    this.content.querySelectorAll('.msg-image[data-ratio]').forEach((el) => {
      el.style.aspectRatio = el.dataset.ratio.replace('/', ' / ');
      el.removeAttribute('data-ratio');
    });
    const imgs = [...this.content.querySelectorAll('img[data-att]:not([src])')];
    await Promise.all(
      imgs.map(async (img) => {
        const url = await attachmentUrl(img.dataset.att);
        if (!img.isConnected) return;
        if (url) img.src = url;
        else img.closest('.msg-image')?.classList.add('is-missing');
      }),
    );
  }

  #flash(btn, withLabel = false) {
    const prev = btn.innerHTML;
    btn.innerHTML = withLabel ? `${icon('check', { size: 14 })}<span>Copied</span>` : icon('check', { size: 15 });
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = prev;
      btn.classList.remove('copied');
    }, 1400);
  }

  #onScroll() {
    const { scrollTop, scrollHeight, clientHeight } = this.scroller;
    const distance = scrollHeight - scrollTop - clientHeight;
    this.stickToBottom = distance < NEAR_BOTTOM;
    this.scrollBtn.hidden = this.stickToBottom || this.main.classList.contains('is-welcome');
  }

  scrollToBottom(smooth) {
    const reduce = this.settings.get('reduceMotion');
    this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
    this.stickToBottom = true;
    this.scrollBtn.hidden = true;
  }
}

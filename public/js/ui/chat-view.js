import { $, escapeHtml, formatDateTime, copyText } from './dom.js';
import { icon } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { toast } from './overlays.js';
import { SUGGESTED_PROMPTS } from '../config.js';

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

    this.scroller.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    this.scrollBtn.addEventListener('click', () => this.scrollToBottom(true));
    this.content.addEventListener('click', (e) => this.#onClick(e));
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
    if (switched) this.seen = new Set(conv.messages.map((m) => m.id));
    this.content.innerHTML = `<div class="messages">${conv.messages.map((m, i) => this.#messageHTML(m, i === this.#lastAssistantIndex(conv), i === conv.messages.length - 1)).join('')}</div>`;
    this.renderedId = conv.id;
    conv.messages.forEach((m) => this.seen.add(m.id));
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
      if (head && msg.meta?.model && !head.querySelector('.msg-model')) head.insertAdjacentHTML('beforeend', `<span class="msg-model">${escapeHtml(msg.meta.model)}</span>`);
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
        <div class="welcome-mark" aria-hidden="true"><img class="logo-ink" src="/assets/brand/emblem.png" alt="" width="72" height="72"></div>
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

  #messageHTML(m, isLastAssistant, isLast) {
    const enter = this.seen.has(m.id) ? '' : ' enter';
    const time = this.settings.get('showTimestamps') ? `<time datetime="${new Date(m.createdAt).toISOString()}">${formatDateTime(m.createdAt)}</time>` : '';

    if (m.role === 'user') {
      return `<article class="msg msg-user${enter}" data-msg="${m.id}">
        <div class="bubble bubble-user">${escapeHtml(m.content)}</div>
        <div class="msg-actions">
          ${time}
          <button type="button" class="act" data-action="copy" title="Copy message" aria-label="Copy message">${icon('copy', { size: 15 })}</button>
        </div>
      </article>`;
    }

    if (m.role === 'notice') return this.#noticeHTML(m, time, isLast, enter);

    // assistant
    const streaming = m.status === 'streaming';
    const body = this.#aiContentHTML(m);
    const tag =
      m.status === 'stopped' ? '<span class="msg-tag">Stopped</span>' : m.status === 'interrupted' ? '<span class="msg-tag">Interrupted</span>' : '';
    const model = m.meta?.model ? `<span class="msg-model">${escapeHtml(m.meta.model)}</span>` : '';
    return `<article class="msg msg-ai${streaming ? ' is-streaming' : ''}${enter}" data-msg="${m.id}">
      <div class="ai-avatar" aria-hidden="true"><img class="logo-ink" src="/assets/brand/emblem.png" alt="" width="18" height="18"></div>
      <div class="ai-body">
        <div class="ai-head"><span class="ai-name">Drone Hive AI</span>${model}${tag}</div>
        <div class="bubble bubble-ai">${body}</div>
        ${streaming ? '' : `<div class="msg-actions">
          ${time}
          <button type="button" class="act" data-action="copy" title="Copy response" aria-label="Copy response">${icon('copy', { size: 15 })}</button>
          ${isLastAssistant ? `<button type="button" class="act" data-action="regenerate" title="Regenerate response" aria-label="Regenerate response">${icon('refresh', { size: 15 })}</button>` : ''}
        </div>`}
      </div>
    </article>`;
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
    if (streaming) return '<div class="thinking" aria-label="Drone Hive AI is responding"><span></span><span></span><span></span></div>';
    return '';
  }

  #noticeHTML(m, time, isLast, enter = '') {
    const v = m.variant || 'error';
    const ico = v === 'disconnected' ? 'plug' : 'alert';
    const title = v === 'disconnected' ? 'AI provider not connected' : v === 'offline' ? 'Server not reachable' : 'Something went wrong';
    return `<article class="msg msg-notice notice-${v}${enter}" data-msg="${m.id}" role="status">
      <div class="notice-icon">${icon(ico, { size: 18 })}</div>
      <div class="notice-body">
        <div class="notice-title">${title}</div>
        <p>${escapeHtml(m.content)}</p>
        <div class="notice-actions">
          ${v !== 'error' || /access code/i.test(m.content) ? `<button type="button" class="btn btn-sm btn-secondary" data-action="open-ai-settings">${icon('settings', { size: 14 })}<span>AI settings</span></button>` : ''}
          ${isLast ? `<button type="button" class="btn btn-sm btn-ghost" data-action="retry">${icon('refresh', { size: 14 })}<span>Try again</span></button>` : ''}
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

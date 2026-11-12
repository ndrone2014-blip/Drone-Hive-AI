import { $, escapeHtml, formatBytes } from './dom.js';
import { icon } from './icons.js';
import { toast } from './overlays.js';
import { LIMITS } from '../config.js';
import { processImage, AttachmentError } from '../core/attachments.js';

const TOUCH = matchMedia('(hover: none) and (pointer: coarse)');

/**
 * Message composer: auto-growing input, Enter to send (desktop), image
 * attachments with previews, clear button, send/stop button.
 */
export class Composer {
  constructor({ settings, actions }) {
    this.settings = settings;
    this.actions = actions; // { send(text, attachments) -> bool, stop() }
    this.busy = false;
    this.pending = []; // [{ key, status: 'processing'|'ready', blob, meta, url }]
    this.images = { enabled: false, reason: 'Checking which AI providers can read images…' };

    this.form = $('#composer');
    this.input = $('#composer-input');
    this.sendBtn = $('#send-btn');
    this.clearBtn = $('#clear-btn');
    this.attachBtn = $('#attach-btn');
    this.fileInput = $('#file-input');
    this.tray = $('#attach-tray');
    this.count = $('#char-count');
    this.hint = $('#composer-hint');

    this.attachBtn.innerHTML = icon('image', { size: 19 });
    this.clearBtn.innerHTML = icon('x');

    this.#bind();
    this.#renderButton();
    this.#renderAttachButton();
    this.updateHint();
  }

  #bind() {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.busy) this.actions.stop();
      else this.submit();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      // On phones and tablets Enter adds a new line; the send button sends.
      if (TOUCH.matches && !e.ctrlKey && !e.metaKey) return;
      const enterToSend = this.settings.get('enterToSend');
      const wantsSend = enterToSend ? !e.shiftKey : e.ctrlKey || e.metaKey;
      if (wantsSend) {
        e.preventDefault();
        if (!this.busy) this.submit();
      }
    });

    this.input.addEventListener('input', () => this.#onInput());

    this.clearBtn.addEventListener('click', () => {
      this.setValue('');
      this.clearAttachments();
      this.input.focus();
    });

    this.attachBtn.addEventListener('click', () => {
      if (!this.images.enabled) {
        toast(this.images.reason, { duration: 4500 });
        return;
      }
      if (this.pending.length >= LIMITS.maxImagesPerMessage) {
        toast(`You can attach up to ${LIMITS.maxImagesPerMessage} images per message.`);
        return;
      }
      this.fileInput.value = '';
      this.fileInput.click();
    });
    this.fileInput.addEventListener('change', () => {
      this.addFiles([...(this.fileInput.files || [])]);
      this.fileInput.value = '';
    });

    // Paste images (screenshots) straight into the message box.
    this.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      this.addFiles(files);
    });

    // Drag and drop onto the chat area.
    const zone = $('#main');
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      zone.classList.add('is-dragging');
    });
    zone.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.classList.remove('is-dragging');
    });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      zone.classList.remove('is-dragging');
      if (!this.images.enabled) return toast(this.images.reason, { duration: 4500 });
      this.addFiles([...e.dataTransfer.files]);
    });

    this.tray.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (!rm) return;
      this.removeAttachment(rm.dataset.remove);
      this.input.focus({ preventScroll: true });
    });
  }

  // ── attachments ────────────────────────────────────────
  /** Turns image uploads on/off depending on what the server's AIs can do. */
  setImageSupport(enabled, reason = '') {
    this.images = { enabled, reason: reason || 'Image uploads aren’t available right now.' };
    this.#renderAttachButton();
  }

  #renderAttachButton() {
    const on = this.images.enabled;
    this.attachBtn.classList.toggle('is-soon', !on);
    const label = on ? `Attach images (up to ${LIMITS.maxImagesPerMessage})` : 'Attach images (not available)';
    this.attachBtn.title = label;
    this.attachBtn.setAttribute('aria-label', label);
  }

  async addFiles(files) {
    if (!files.length || this.busy) return;
    const room = LIMITS.maxImagesPerMessage - this.pending.length;
    if (room <= 0) return toast(`You can attach up to ${LIMITS.maxImagesPerMessage} images per message.`);
    if (files.length > room) toast(`Only ${room} more image${room === 1 ? '' : 's'} can be added to this message.`);
    const batch = files.slice(0, room).map((file) => ({ key: Math.random().toString(36).slice(2), status: 'processing', name: file.name, file }));
    this.pending.push(...batch);
    this.#renderTray();
    await Promise.all(
      batch.map(async (item) => {
        try {
          const { blob, meta } = await processImage(item.file);
          if (!this.pending.includes(item)) return; // removed while processing
          Object.assign(item, { status: 'ready', blob, meta, url: URL.createObjectURL(blob), file: null });
        } catch (err) {
          this.pending = this.pending.filter((x) => x !== item);
          toast(err instanceof AttachmentError ? err.message : 'That image couldn’t be added.', { type: 'error', duration: 5000 });
        }
        this.#renderTray();
      }),
    );
  }

  removeAttachment(key) {
    const item = this.pending.find((x) => x.key === key);
    if (item?.url) URL.revokeObjectURL(item.url);
    this.pending = this.pending.filter((x) => x.key !== key);
    this.#renderTray();
  }

  clearAttachments({ revoke = true } = {}) {
    if (revoke) this.pending.forEach((x) => x.url && URL.revokeObjectURL(x.url));
    this.pending = [];
    this.#renderTray();
  }

  #renderTray() {
    this.tray.hidden = !this.pending.length;
    this.tray.innerHTML = this.pending
      .map(
        (x) => `<div class="attach-chip${x.status === 'processing' ? ' is-loading' : ''}">
          ${x.url ? `<img src="${escapeHtml(x.url)}" alt="">` : '<span class="attach-spinner" aria-hidden="true"></span>'}
          <span class="attach-meta"><span class="attach-name">${escapeHtml(x.meta?.name || x.name || 'Image')}</span><span class="attach-size">${x.status === 'processing' ? 'Preparing…' : `${x.meta.width}×${x.meta.height} · ${formatBytes(x.meta.size)}`}</span></span>
          <button type="button" class="attach-remove" data-remove="${x.key}" aria-label="Remove ${escapeHtml(x.meta?.name || x.name || 'image')}">${icon('x', { size: 14 })}</button>
        </div>`,
      )
      .join('');
    this.#onInput();
  }

  get processing() {
    return this.pending.some((x) => x.status === 'processing');
  }

  // ── text ───────────────────────────────────────────────
  #onInput() {
    this.#autosize();
    const len = this.input.value.length;
    const hasContent = this.input.value.trim().length > 0 || this.pending.length > 0;
    this.clearBtn.hidden = len === 0 && !this.pending.length;
    if (len > LIMITS.maxMessageChars * 0.8) {
      this.count.hidden = false;
      this.count.textContent = `${len.toLocaleString()} / ${LIMITS.maxMessageChars.toLocaleString()}`;
      this.count.classList.toggle('over', len > LIMITS.maxMessageChars);
    } else this.count.hidden = true;
    if (!this.busy) this.sendBtn.disabled = !hasContent || len > LIMITS.maxMessageChars || this.processing;
  }

  #autosize() {
    this.input.style.height = 'auto';
    const vh = window.visualViewport?.height || window.innerHeight;
    const max = Math.round(vh * (TOUCH.matches ? 0.28 : 0.4));
    this.input.style.height = `${Math.min(this.input.scrollHeight, max)}px`;
    this.input.style.overflowY = this.input.scrollHeight > max ? 'auto' : 'hidden';
  }

  submit() {
    const text = this.input.value;
    if (this.processing) return toast('Wait a moment — your image is still being prepared.');
    const attachments = this.pending.filter((x) => x.status === 'ready').map(({ blob, meta }) => ({ blob, meta }));
    if (!text.trim() && !attachments.length) return;
    if (text.length > LIMITS.maxMessageChars) {
      toast(`Message is too long (max ${LIMITS.maxMessageChars.toLocaleString()} characters).`, { type: 'error' });
      return;
    }
    const accepted = this.actions.send(text, attachments);
    if (accepted !== false) {
      this.setValue('');
      this.clearAttachments();
    }
  }

  setValue(text, { focus = false } = {}) {
    this.input.value = text;
    this.#onInput();
    if (focus) {
      this.input.focus();
      this.input.setSelectionRange(text.length, text.length);
    }
  }

  focus() {
    // Don't pop up the on-screen keyboard by itself on phones.
    if (TOUCH.matches) return;
    this.input.focus({ preventScroll: true });
  }

  /** While a reply is in progress the send button becomes a stop button. */
  setBusy(busy) {
    this.busy = busy;
    this.form.classList.toggle('is-busy', busy);
    this.#renderButton();
    this.#onInput();
  }

  #renderButton() {
    if (this.busy) {
      this.sendBtn.innerHTML = icon('stop', { size: 16 });
      this.sendBtn.setAttribute('aria-label', 'Stop response');
      this.sendBtn.title = 'Stop response';
      this.sendBtn.disabled = false;
    } else {
      this.sendBtn.innerHTML = icon('send', { size: 18, strokeWidth: 2.2 });
      this.sendBtn.setAttribute('aria-label', 'Send message');
      this.sendBtn.title = 'Send message';
    }
  }

  updateHint() {
    this.hint.innerHTML = this.settings.get('enterToSend')
      ? '<kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line · paste or drop images'
      : '<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send · <kbd>Enter</kbd> for a new line · paste or drop images';
  }
}

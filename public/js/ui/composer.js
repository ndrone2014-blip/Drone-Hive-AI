import { $ } from './dom.js';
import { icon } from './icons.js';
import { toast } from './overlays.js';
import { FEATURES, LIMITS } from '../config.js';

/**
 * Message composer: auto-growing input, Enter to send, Shift+Enter for a new
 * line, clear button, attachment placeholder, send/stop button.
 */
export class Composer {
  constructor({ settings, actions }) {
    this.settings = settings;
    this.actions = actions; // { send(text), stop() }
    this.busy = false;

    this.form = $('#composer');
    this.input = $('#composer-input');
    this.sendBtn = $('#send-btn');
    this.clearBtn = $('#clear-btn');
    this.attachBtn = $('#attach-btn');
    this.count = $('#char-count');
    this.hint = $('#composer-hint');

    this.attachBtn.innerHTML = icon('paperclip');
    this.clearBtn.innerHTML = icon('x');
    if (!FEATURES.fileUploads) this.attachBtn.classList.add('is-soon');

    this.#bind();
    this.#renderButton();
    this.updateHint();
  }

  #bind() {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.busy) this.actions.stop();
      else this.submit();
    });

    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
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
      this.input.focus();
    });

    this.attachBtn.addEventListener('click', () => {
      // FUTURE: open a file picker and add attachments as message content parts.
      toast('File and image uploads are coming in a future update.');
    });
  }

  #onInput() {
    this.#autosize();
    const len = this.input.value.length;
    const hasText = this.input.value.trim().length > 0;
    this.clearBtn.hidden = len === 0;
    if (len > LIMITS.maxMessageChars * 0.8) {
      this.count.hidden = false;
      this.count.textContent = `${len.toLocaleString()} / ${LIMITS.maxMessageChars.toLocaleString()}`;
      this.count.classList.toggle('over', len > LIMITS.maxMessageChars);
    } else this.count.hidden = true;
    if (!this.busy) this.sendBtn.disabled = !hasText || len > LIMITS.maxMessageChars;
  }

  #autosize() {
    this.input.style.height = 'auto';
    const max = Math.round(window.innerHeight * 0.4);
    this.input.style.height = `${Math.min(this.input.scrollHeight, max)}px`;
    this.input.style.overflowY = this.input.scrollHeight > max ? 'auto' : 'hidden';
  }

  submit() {
    const text = this.input.value;
    if (!text.trim()) return;
    if (text.length > LIMITS.maxMessageChars) {
      toast(`Message is too long (max ${LIMITS.maxMessageChars.toLocaleString()} characters).`, { type: 'error' });
      return;
    }
    const accepted = this.actions.send(text);
    if (accepted !== false) this.setValue('');
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
      ? '<kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line'
      : '<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send · <kbd>Enter</kbd> for a new line';
  }
}

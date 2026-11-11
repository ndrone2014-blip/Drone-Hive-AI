import { html, escapeHtml, formatBytes, formatDateTime } from './dom.js';
import { icon } from './icons.js';
import { APP } from '../config.js';

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'ai', label: 'AI Configuration', icon: 'cpu' },
  { id: 'data', label: 'Data & Privacy', icon: 'shield' },
  { id: 'about', label: 'About', icon: 'info' },
];

/**
 * Settings dashboard (modal). Every control writes straight to SettingsStore.
 */
export class SettingsModal {
  constructor({ settings, store, connection, actions }) {
    this.settings = settings;
    this.store = store;
    this.connection = connection;
    this.actions = actions; // { clearAll, deleteConversation, exportAll, refreshConnection }
    this.el = null;
    this.section = 'general';

    connection.on('change', () => {
      if (this.el && this.section === 'ai') this.#renderSection();
    });
    store.on('change', () => {
      if (this.el && this.section === 'data') this.#renderSection();
    });
  }

  get isOpen() {
    return Boolean(this.el);
  }

  open(section = 'general', focusKey = null) {
    this.section = SECTIONS.some((s) => s.id === section) ? section : 'general';
    if (!this.el) this.#mount();
    this.#renderNav();
    this.#renderSection();
    if (this.section === 'ai') this.actions.refreshConnection();
    if (focusKey) requestAnimationFrame(() => this.el?.querySelector(`[data-setting="${focusKey}"]`)?.focus());
  }

  close() {
    if (!this.el) return;
    const el = this.el;
    this.el = null;
    el.classList.remove('show');
    document.removeEventListener('keydown', this.onKey, true);
    setTimeout(() => el.remove(), 180);
    this.previousFocus?.focus?.();
  }

  #mount() {
    this.previousFocus = document.activeElement;
    this.el = html(`
      <div class="modal-backdrop">
        <div class="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <aside class="settings-nav">
            <h2 id="settings-title">Settings</h2>
            <nav id="settings-tabs" role="tablist" aria-orientation="vertical"></nav>
            <div class="settings-nav-foot">
              <img class="logo-ink" src="/assets/brand/wordmark.png" alt="Drone Hive Studios" width="120">
              <span>v${APP.version}</span>
            </div>
          </aside>
          <section class="settings-body">
            <button type="button" class="icon-btn settings-close" aria-label="Close settings">${icon('x')}</button>
            <div class="settings-content" id="settings-content" role="tabpanel"></div>
          </section>
        </div>
      </div>`);
    document.body.appendChild(this.el);
    requestAnimationFrame(() => this.el?.classList.add('show'));

    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.querySelector('.settings-close').addEventListener('click', () => this.close());
    this.onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.dialog-backdrop')) {
        e.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('keydown', this.onKey, true);

    this.el.querySelector('#settings-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('[data-section]');
      if (!tab) return;
      this.section = tab.dataset.section;
      this.#renderNav();
      this.#renderSection();
      if (this.section === 'ai') this.actions.refreshConnection();
    });

    const content = this.el.querySelector('#settings-content');
    content.addEventListener('click', (e) => this.#onClick(e));
    content.addEventListener('change', (e) => this.#onChange(e));
    content.addEventListener('input', (e) => this.#onInput(e));
  }

  #renderNav() {
    this.el.querySelector('#settings-tabs').innerHTML = SECTIONS.map(
      (s) => `<button type="button" role="tab" class="settings-tab${s.id === this.section ? ' active' : ''}" aria-selected="${s.id === this.section}" data-section="${s.id}">${icon(s.icon, { size: 17 })}<span>${s.label}</span></button>`,
    ).join('');
  }

  #renderSection() {
    const content = this.el.querySelector('#settings-content');
    const keepScroll = content.dataset.section === this.section ? content.scrollTop : 0;
    const active = document.activeElement;
    const activeKey = content.contains(active) ? active.dataset.setting : null;
    const renderers = { general: () => this.#general(), ai: () => this.#ai(), data: () => this.#data(), about: () => this.#about() };
    content.innerHTML = renderers[this.section]();
    content.dataset.section = this.section;
    content.scrollTop = keepScroll;
    if (activeKey) content.querySelector(`[data-setting="${activeKey}"]`)?.focus();
  }

  // ── sections ──────────────────────────────────────────
  #general() {
    const s = this.settings.all();
    return `
      <h3 class="section-title">General</h3>
      <p class="section-sub">Appearance, interface and chat preferences.</p>

      <div class="group">
        <div class="group-label">Profile</div>
        <label class="row">
          <span class="row-text"><span class="row-title">Display name</span><span class="row-sub">Used for your avatar and greeting. Stored only in this browser.</span></span>
          <input class="input input-sm" type="text" maxlength="40" placeholder="Your name" value="${escapeHtml(s.displayName)}" data-setting="displayName" data-kind="text">
        </label>
      </div>

      <div class="group">
        <div class="group-label">Appearance</div>
        <div class="row">
          <span class="row-text"><span class="row-title">Theme</span><span class="row-sub">Match your system or choose a mode.</span></span>
          ${segmented('theme', s.theme, [
            ['system', 'System', 'monitor'],
            ['light', 'Light', 'sun'],
            ['dark', 'Dark', 'moon'],
          ])}
        </div>
        <div class="row">
          <span class="row-text"><span class="row-title">Text size</span></span>
          ${segmented('fontSize', s.fontSize, [
            ['small', 'Small'],
            ['default', 'Default'],
            ['large', 'Large'],
          ])}
        </div>
      </div>

      <div class="group">
        <div class="group-label">Interface</div>
        ${toggleRow('showTimestamps', s.showTimestamps, 'Show message timestamps')}
        ${toggleRow('reduceMotion', s.reduceMotion, 'Reduce motion', 'Turns off animations and smooth scrolling.')}
      </div>

      <div class="group">
        <div class="group-label">Chat</div>
        ${toggleRow('enterToSend', s.enterToSend, 'Press Enter to send', 'When off, use Ctrl+Enter to send and Enter for a new line.')}
        ${toggleRow('autoScroll', s.autoScroll, 'Auto-scroll to new messages')}
      </div>`;
  }

  #ai() {
    const s = this.settings.all();
    const { state, status } = this.connection;
    const providers = status?.providers || [];
    const configured = providers.filter((p) => p.configured);
    const selected = providers.find((p) => p.id === s.provider && p.configured) || this.connection.activeProvider;
    const models = selected?.models || [];
    const model = models.includes(s.model) ? s.model : selected?.defaultModel || '';
    const maxOut = status?.limits?.maxOutputTokens || 4096;

    const stateInfo = {
      connected: ['Connected', `Replies are powered by ${escapeHtml(this.connection.activeProvider?.name || 'your AI provider')}.`],
      disconnected: ['Not connected', 'The server is running, but no AI provider API key has been added yet.'],
      offline: ['Server not reachable', 'The app is open, but its API server is not running at this address.'],
      checking: ['Checking…', 'Contacting the Drone Hive AI server.'],
    }[state];

    const keyRows = providers.length
      ? providers
          .map(
            (p) => `<div class="key-row">
              <span class="key-name">${icon('key', { size: 15 })}${escapeHtml(p.name)}</span>
              <span class="chip ${p.configured ? 'chip-ok' : ''}">${p.configured ? 'Key set on server' : 'Not set'}</span>
            </div>`,
          )
          .join('')
      : '<div class="key-row"><span class="key-name">Provider list unavailable while the server is offline.</span></div>';

    return `
      <h3 class="section-title">AI Configuration</h3>
      <p class="section-sub">Choose how Drone Hive AI generates replies.</p>

      <div class="status-card" data-state="${state}">
        <span class="status-dot"></span>
        <div class="status-text"><b>${stateInfo[0]}</b><span>${stateInfo[1]}</span></div>
        <button type="button" class="btn btn-sm btn-secondary" data-action="refresh">${icon('refresh', { size: 14 })}<span>Check again</span></button>
      </div>

      <div class="group">
        <div class="group-label">Provider & model</div>
        <label class="row">
          <span class="row-text"><span class="row-title">AI provider</span><span class="row-sub">Only providers with a key on the server can be selected.</span></span>
          <select class="input input-sm" data-setting="provider" ${configured.length ? '' : 'disabled'}>
            <option value="auto" ${s.provider === 'auto' ? 'selected' : ''}>Automatic</option>
            ${providers
              .map((p) => `<option value="${p.id}" ${p.id === s.provider ? 'selected' : ''} ${p.configured ? '' : 'disabled'}>${escapeHtml(p.name)}${p.configured ? '' : ' — needs key'}</option>`)
              .join('')}
          </select>
        </label>
        <label class="row">
          <span class="row-text"><span class="row-title">Model</span><span class="row-sub">Models allowed by the server for this provider.</span></span>
          <select class="input input-sm" data-setting="model" ${models.length ? '' : 'disabled'}>
            ${models.length ? models.map((m) => `<option value="${escapeHtml(m)}" ${m === model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('') : '<option>Connect a provider first</option>'}
          </select>
        </label>
      </div>

      <div class="group">
        <div class="group-label">API key</div>
        <p class="group-note">${icon('shield', { size: 15 })}<span>For security, API keys are <b>never</b> entered or stored in the browser. They live in the server's environment variables, where visitors can't see them.</span></p>
        <div class="key-box">
          <input class="input input-sm" type="password" disabled placeholder="Stored on the server — not editable here" aria-label="API key (managed on the server)">
          ${keyRows}
        </div>
        <details class="howto">
          <summary>How to add your API key</summary>
          <ol>
            <li><b>On Netlify:</b> Project (or Site) configuration → Environment variables → Add a variable. Name it <code>ANTHROPIC_API_KEY</code> or <code>OLLAMA_API_KEY</code> (scope must include Functions), paste your key, then redeploy.</li>
            <li><b>On your PC:</b> copy <code>.env.example</code> to <code>.env</code>, set your key (e.g. <code>OLLAMA_API_KEY=…</code>), and restart <code>npm start</code>.</li>
            <li><b>Ollama:</b> use the variable name <code>OLLAMA_API_KEY</code> instead.</li>
            <li>Other providers: set the <code>OPENAI_COMPAT_*</code> variables (see the README).</li>
          </ol>
        </details>
        ${status?.accessCodeRequired || s.accessCode ? `
        <label class="row">
          <span class="row-text"><span class="row-title">Access code</span><span class="row-sub">This server is protected. Enter the code set in <code>DRONEHIVE_ACCESS_CODE</code>.</span></span>
          <input class="input input-sm" type="password" autocomplete="off" placeholder="Access code" value="${escapeHtml(s.accessCode)}" data-setting="accessCode" data-kind="text">
        </label>` : ''}
      </div>

      <div class="group">
        <div class="group-label">Responses</div>
        ${toggleRow('streamResponses', s.streamResponses, 'Stream responses', 'Show the reply word-by-word as it is written.')}
        <div class="row">
          <span class="row-text"><span class="row-title">Creativity (temperature)</span><span class="row-sub">Lower is more focused, higher is more creative.</span></span>
          <div class="temp-control">
            <label class="mini-check"><input type="checkbox" data-action="temp-default" ${s.temperature == null ? 'checked' : ''}><span>Default</span></label>
            <input type="range" min="0" max="1" step="0.1" value="${s.temperature ?? 0.7}" data-setting="temperature" data-kind="number" ${s.temperature == null ? 'disabled' : ''} aria-label="Temperature">
            <output>${s.temperature == null ? '—' : Number(s.temperature).toFixed(1)}</output>
          </div>
        </div>
        <label class="row">
          <span class="row-text"><span class="row-title">Max response length</span><span class="row-sub">Server limit: ${maxOut.toLocaleString()} tokens.</span></span>
          <select class="input input-sm" data-setting="maxTokens" data-kind="nullable-number">
            <option value="" ${s.maxTokens == null ? 'selected' : ''}>Default</option>
            ${[1024, 2048, 4096, 8192].filter((n) => n <= maxOut).map((n) => `<option value="${n}" ${s.maxTokens === n ? 'selected' : ''}>${n.toLocaleString()} tokens</option>`).join('')}
          </select>
        </label>
      </div>

      <div class="group">
        <div class="group-label">Custom instructions</div>
        <p class="group-note">${icon('info', { size: 15 })}<span>Added to every conversation, on top of Drone Hive AI's built-in personality. Example: “I mostly code in JavaScript. Keep answers short.”</span></p>
        <textarea class="input textarea" rows="4" maxlength="4000" placeholder="Tell Drone Hive AI how to respond…" data-setting="customInstructions" data-kind="text" ${status && status.customInstructionsAllowed === false ? 'disabled' : ''}>${escapeHtml(s.customInstructions)}</textarea>
      </div>`;
  }

  #data() {
    const st = this.store.stats();
    const list = this.store.list();
    return `
      <h3 class="section-title">Data & Privacy</h3>
      <p class="section-sub">Your conversations stay in this browser.</p>

      <div class="stat-grid">
        <div class="stat"><span class="stat-num">${st.conversations}</span><span class="stat-label">Conversations</span></div>
        <div class="stat"><span class="stat-num">${st.messages}</span><span class="stat-label">Messages</span></div>
        <div class="stat"><span class="stat-num">${formatBytes(st.bytes)}</span><span class="stat-label">Storage used</span></div>
      </div>

      <div class="group">
        <div class="group-label">Local storage</div>
        <p class="group-note">${icon('database', { size: 15 })}<span>${
          st.persistent
            ? 'Conversations and settings are saved in this browser’s local storage. They are not uploaded anywhere. Only the messages you send are passed through the server to the AI provider to generate replies. Clearing your browser data or using another device will not show these chats.'
            : 'Your browser is blocking local storage (for example in private mode), so conversations will be lost when this tab closes.'
        }</span></p>
      </div>

      <div class="group">
        <div class="group-label">Export</div>
        <div class="row">
          <span class="row-text"><span class="row-title">Export all conversations</span><span class="row-sub">Download everything as a JSON file.</span></span>
          <button type="button" class="btn btn-sm btn-secondary" data-action="export" ${st.conversations ? '' : 'disabled'}>${icon('download', { size: 14 })}<span>Export</span></button>
        </div>
      </div>

      <div class="group">
        <div class="group-label">Conversations</div>
        ${
          list.length
            ? `<div class="data-list">${list
                .map(
                  (c) => `<div class="data-item">
                    <span class="data-text"><span class="data-title">${escapeHtml(c.title)}</span><span class="data-sub">${c.messages.filter((m) => m.role !== 'notice').length} messages · ${formatDateTime(c.updatedAt)}</span></span>
                    <button type="button" class="icon-btn icon-btn-danger" data-action="delete-conv" data-id="${c.id}" aria-label="Delete ${escapeHtml(c.title)}" title="Delete">${icon('trash', { size: 16 })}</button>
                  </div>`,
                )
                .join('')}</div>`
            : '<p class="muted">No saved conversations.</p>'
        }
      </div>

      <div class="group danger-zone">
        <div class="group-label">Danger zone</div>
        <div class="row">
          <span class="row-text"><span class="row-title">Clear chat history</span><span class="row-sub">Permanently deletes all conversations in this browser.</span></span>
          <button type="button" class="btn btn-sm btn-danger" data-action="clear-all" ${st.conversations ? '' : 'disabled'}>${icon('trash', { size: 14 })}<span>Clear all</span></button>
        </div>
        <div class="row">
          <span class="row-text"><span class="row-title">Reset settings</span><span class="row-sub">Restore all preferences to their defaults. Conversations are kept.</span></span>
          <button type="button" class="btn btn-sm btn-secondary" data-action="reset-settings">${icon('refresh', { size: 14 })}<span>Reset</span></button>
        </div>
      </div>`;
  }

  #about() {
    return `
      <div class="about-hero">
        <img class="logo-ink about-logo" src="/assets/brand/logo-full.png" alt="Drone Hive Studios" width="220">
        <div class="about-tags"><span>Websites</span><i></i><span>Bots</span><i></i><span>Games</span></div>
      </div>
      <div class="group">
        <div class="group-label">Drone Hive AI</div>
        <div class="row"><span class="row-text"><span class="row-title">Version</span></span><span class="chip">v${APP.version}</span></div>
        <p class="about-text">Drone Hive AI is an AI assistant built by Drone Hive Studios to help with code, ideas and writing. It connects to the AI provider of your choice through a secure server, keeps your conversations on your own device and is designed to grow with new features over time.</p>
      </div>
      <div class="group">
        <div class="group-label">Credits</div>
        <p class="about-text"><b>${escapeHtml(APP.credits)}</b></p>
        <p class="about-text muted">Built with plain HTML, CSS and JavaScript and Netlify Edge Functions — no frameworks, no tracking.</p>
      </div>`;
  }

  // ── events ────────────────────────────────────────────
  async #onClick(e) {
    const btn = e.target.closest('[data-action], [data-seg]');
    if (!btn) return;
    if (btn.dataset.seg) {
      this.settings.set(btn.dataset.seg, btn.dataset.value);
      this.#renderSection();
      return;
    }
    switch (btn.dataset.action) {
      case 'refresh':
        this.actions.refreshConnection();
        break;
      case 'export':
        this.actions.exportAll();
        break;
      case 'delete-conv':
        await this.actions.deleteConversation(btn.dataset.id);
        break;
      case 'clear-all':
        await this.actions.clearAll();
        break;
      case 'reset-settings':
        await this.actions.resetSettings();
        this.#renderSection();
        break;
      default:
    }
  }

  #onChange(e) {
    const t = e.target;
    if (t.dataset.action === 'temp-default') {
      this.settings.set('temperature', t.checked ? null : 0.7);
      this.#renderSection();
      return;
    }
    const key = t.dataset.setting;
    if (!key) return;
    if (t.type === 'checkbox') this.settings.set(key, t.checked);
    else if (t.tagName === 'SELECT') {
      const v = t.dataset.kind === 'nullable-number' ? (t.value ? Number(t.value) : null) : t.value;
      this.settings.set(key, v);
      if (key === 'provider') {
        this.settings.set('model', '');
        this.#renderSection();
      }
    }
  }

  #onInput(e) {
    const t = e.target;
    const key = t.dataset.setting;
    if (!key) return;
    if (t.type === 'range') {
      const v = Number(t.value);
      this.settings.set(key, v);
      const out = t.parentElement.querySelector('output');
      if (out) out.textContent = v.toFixed(1);
    } else if (t.dataset.kind === 'text') {
      this.settings.set(key, t.value);
    }
  }
}

function segmented(key, value, options) {
  return `<div class="segmented" role="radiogroup">${options
    .map(
      ([v, label, ico]) => `<button type="button" role="radio" aria-checked="${v === value}" class="seg${v === value ? ' active' : ''}" data-seg="${key}" data-value="${v}">${ico ? icon(ico, { size: 15 }) : ''}<span>${label}</span></button>`,
    )
    .join('')}</div>`;
}

function toggleRow(key, checked, title, sub = '') {
  return `<label class="row">
    <span class="row-text"><span class="row-title">${title}</span>${sub ? `<span class="row-sub">${sub}</span>` : ''}</span>
    <span class="switch"><input type="checkbox" data-setting="${key}" ${checked ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></span>
  </label>`;
}


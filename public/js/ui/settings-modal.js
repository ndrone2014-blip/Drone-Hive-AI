import { html, escapeHtml, formatBytes, formatDateTime, copyText } from './dom.js';
import { icon } from './icons.js';
import { toast, confirmDialog } from './overlays.js';
import { APP, AI_MODES, contactLink } from '../config.js';
import { MEMORY_CATEGORIES, MEMORY_LIMITS } from '../shared/memory-rules.js';

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'account', label: 'Account', icon: 'user', when: (m) => m.auth?.required },
  { id: 'ai', label: 'AI Configuration', icon: 'cpu' },
  { id: 'memory', label: 'Memory', icon: 'brain' },
  { id: 'data', label: 'Data & Privacy', icon: 'shield' },
  { id: 'about', label: 'About & Contact', icon: 'info' },
];

/**
 * Settings dashboard (modal). Every control writes straight to SettingsStore.
 */
export class SettingsModal {
  constructor({ settings, store, connection, auth, memory, actions, getQuota = () => null }) {
    this.auth = auth;
    this.memory = memory;
    this.memEditId = null; // memory being edited
    this.memDraft = ''; // text in the "add a memory" box
    this.memQuery = '';
    this.getQuota = getQuota;
    this.settings = settings;
    this.store = store;
    this.connection = connection;
    this.actions = actions; // { clearAll, deleteConversation, exportAll, refreshConnection }
    this.el = null;
    this.section = 'general';

    connection.on('change', () => {
      if (this.el && this.section === 'ai') this.#renderSection();
    });
    auth?.on('change', () => {
      if (this.el) {
        this.#renderNav();
        if (this.section === 'account') this.#renderSection();
      }
    });
    store.on('change', () => {
      if (this.el && this.section === 'data') this.#renderSection();
    });
    memory?.on('change', () => {
      if (this.el && this.section === 'memory') this.#renderSection();
    });
  }

  get isOpen() {
    return Boolean(this.el);
  }

  open(section = 'general', focusKey = null) {
    this.section = this.#sections().some((s) => s.id === section) ? section : 'general';
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

    this.el.addEventListener('pointerdown', (e) => {
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
    content.addEventListener('submit', (e) => this.#onSubmit(e));
  }

  #sections() {
    return SECTIONS.filter((s) => !s.when || s.when(this));
  }

  #renderNav() {
    const tabs = this.el.querySelector('#settings-tabs');
    tabs.innerHTML = this.#sections().map(
      (s) => `<button type="button" role="tab" class="settings-tab${s.id === this.section ? ' active' : ''}" aria-selected="${s.id === this.section}" data-section="${s.id}">${icon(s.icon, { size: 17 })}<span>${s.label}</span></button>`,
    ).join('');
    // Phones show the tabs in a scrolling row: keep the open one visible.
    const active = tabs.querySelector('.active');
    if (active && tabs.scrollWidth > tabs.clientWidth) tabs.scrollLeft = Math.max(0, active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2);
  }

  #renderSection() {
    const content = this.el.querySelector('#settings-content');
    const keepScroll = content.dataset.section === this.section ? content.scrollTop : 0;
    const active = document.activeElement;
    const activeKey = content.contains(active) ? active.dataset.setting : null;
    const renderers = { general: () => this.#general(), account: () => this.#account(), ai: () => this.#ai(), memory: () => this.#memory(), data: () => this.#data(), about: () => this.#about() };
    content.innerHTML = renderers[this.section]();
    content.querySelectorAll('[data-pct]').forEach((el) => (el.style.width = `${el.dataset.pct}%`));
    content.dataset.section = this.section;
    content.scrollTop = keepScroll;
    if (activeKey) content.querySelector(`[data-setting="${activeKey}"]`)?.focus();
    const editBox = content.querySelector('.mem-edit textarea');
    if (editBox && !editBox.dataset.focused) {
      editBox.dataset.focused = '1';
      editBox.focus();
      editBox.setSelectionRange(editBox.value.length, editBox.value.length);
    }
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

  #account() {
    const u = this.auth?.user;
    const via = u?.provider === 'google.com' ? 'Google' : 'Email and password';
    return `
      <h3 class="section-title">Account</h3>
      <p class="section-sub">You’re signed in. Accounts keep bots from using Drone Hive AI.</p>
      <div class="group">
        <div class="group-label">Signed in as</div>
        <div class="row"><span class="row-text"><span class="row-title">Email</span></span><span class="chip">${escapeHtml(u?.email || '—')}</span></div>
        <div class="row"><span class="row-text"><span class="row-title">Sign-in method</span></span><span class="chip">${via}</span></div>
      </div>
      <div class="group">
        <div class="group-label">Session</div>
        <div class="row">
          <span class="row-text"><span class="row-title">Sign out</span><span class="row-sub">Your conversations stay saved in this browser.</span></span>
          <button type="button" class="btn btn-sm btn-secondary" data-action="sign-out">Sign out</button>
        </div>
      </div>`;
  }

  #ai() {
    const s = this.settings.all();
    const { state, status } = this.connection;
    const providers = status?.providers || [];
    const configured = providers.filter((p) => p.configured);
    const choice = s.provider === 'automatic' || s.provider === 'default' || configured.some((p) => p.id === s.provider) ? s.provider : 'automatic';
    const active = this.connection.activeProvider;
    const modelProvider = choice === 'default' ? active : choice === 'automatic' ? null : providers.find((p) => p.id === choice);
    const models = modelProvider?.models || [];
    const model = models.includes(s.model) ? s.model : modelProvider?.defaultModel || '';
    const lengths = status?.limits?.responseLengths || { short: 2000, medium: 8000 };
    const order = (status?.automaticOrder || ['gemini', 'mistral', 'openrouter', 'groq', 'ollama']).map((id) => providers.find((p) => p.id === id)).filter(Boolean);

    const stateInfo = {
      connected: ['Connected', `${configured.length} AI provider${configured.length === 1 ? '' : 's'} available. Automatic picks the best one for each message.`],
      disconnected: ['Not connected', 'The server is running, but no AI provider API key has been added yet.'],
      offline: ['Server not reachable', 'The app is open, but its API server is not running at this address.'],
      checking: ['Checking…', 'Contacting the Drone Hive AI server.'],
    }[state];

    const keyRows = providers.length
      ? providers
          .filter((p) => p.configured || p.id !== 'openai-compatible')
          .map(
            (p) => `<div class="key-row">
              <span class="key-name">${icon('key', { size: 15 })}${escapeHtml(p.name)}</span>
              <span class="key-chips">${p.configured && p.capabilities?.vision ? `<span class="chip">${icon('image', { size: 13 })}Images</span>` : ''}<span class="chip ${p.configured ? 'chip-ok' : p.issue ? 'chip-warn' : ''}" ${p.issue === 'gateway-placeholder' ? 'title="Netlify added a placeholder key that only works through its paid AI Gateway. Add your own free key (see below)."' : ''}>${p.configured ? 'Key set on server' : p.issue === 'gateway-placeholder' ? 'Needs your own key' : 'Not set'}</span></span>
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

      ${this.#usageCard()}

      <div class="group">
        <div class="group-label">AI selection</div>
        <label class="row">
          <span class="row-text"><span class="row-title">Mode</span><span class="row-sub">${
            choice === 'automatic' ? 'Picks the best AI for each message. This is the standard mode.' : choice === 'default' ? 'Uses the standard provider, with automatic backup if it’s busy.' : 'Always uses this provider. If it’s unavailable, you’ll be told instead of switched.'
          }</span></span>
          <select class="input input-sm" data-setting="provider" ${configured.length ? '' : 'disabled'}>
            <optgroup label="Mode">
              <option value="automatic" ${choice === 'automatic' ? 'selected' : ''}>Automatic (recommended)</option>
              <option value="default" ${choice === 'default' ? 'selected' : ''}>Default</option>
            </optgroup>
            <optgroup label="Always use">
              ${providers
                .filter((p) => p.configured || p.id !== 'openai-compatible')
                .map((p) => `<option value="${p.id}" ${p.id === choice ? 'selected' : ''} ${p.configured ? '' : 'disabled'}>${escapeHtml(p.name)}${p.configured ? '' : ' — needs key'}</option>`)
                .join('')}
            </optgroup>
          </select>
        </label>
        ${
          choice === 'automatic'
            ? `<div class="auto-explainer">
                <p>${icon('sparkle', { size: 15 })}<span>Each message is checked first — coding, reasoning, images, long or quick chat — and the best-suited connected AI answers it (for example Vibe AI for code, Google Gemini for images). It stays with the same AI during a chat when that still fits, and moves to the next one only if it’s busy or down. Backup order:</span></p>
                <ol class="auto-order">${order
                  .map(
                    (p, i) => `<li class="${p.configured ? '' : 'is-off'}"><span class="auto-rank">${i + 1}</span><span class="auto-name">${escapeHtml(p.name)}</span>${
                      p.configured ? (p.capabilities?.vision ? '<span class="chip">Text + images</span>' : '<span class="chip">Text</span>') : '<span class="chip">Not connected</span>'
                    }</li>`,
                  )
                  .join('')}</ol>
              </div>`
            : `<label class="row">
                <span class="row-text"><span class="row-title">Model</span><span class="row-sub">${modelProvider ? `Models allowed by the server for ${escapeHtml(modelProvider.name)}.` : 'Connect a provider first.'}</span></span>
                <select class="input input-sm" data-setting="model" ${models.length ? '' : 'disabled'}>
                  ${models.length ? models.map((m) => `<option value="${escapeHtml(m)}" ${m === model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('') : '<option>Connect a provider first</option>'}
                </select>
              </label>`
        }
      </div>

      <div class="group">
        <div class="group-label">API keys</div>
        <p class="group-note">${icon('shield', { size: 15 })}<span>For security, API keys are <b>never</b> entered or stored in the browser. They live in the server's environment variables, where visitors can't see them.</span></p>
        <div class="key-box">${keyRows}</div>
        <details class="howto">
          <summary>How to add an API key</summary>
          <ol>
            <li><b>On Netlify:</b> Project configuration → Environment variables → Add a variable (mark it as a secret, scope must include Functions), then redeploy. Names: <code>GEMINI_API_KEY</code> (or <code>GOOGLE_API_KEY</code>), <code>MISTRAL_API_KEY</code> (Vibe AI), <code>OPENROUTER_API_KEY</code>, <code>GROQ_API_KEY</code>, <code>OLLAMA_API_KEY</code>.</li>
            <li><b>On your PC:</b> copy <code>.env.example</code> to <code>.env</code>, add the key, and restart <code>npm start</code>.</li>
            <li><b>Free keys:</b> Gemini at <code>aistudio.google.com/apikey</code>, Vibe AI (Mistral AI) at <code>console.mistral.ai/api-keys</code>, OpenRouter at <code>openrouter.ai/keys</code> (only free models are used), Groq at <code>console.groq.com/keys</code>, Ollama at <code>ollama.com</code> → Settings → Keys.</li>
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
        ${toggleRow('showProviderChip', s.showProviderChip, 'Show which AI answered', 'Technical: adds a small label with the AI provider and model to each reply. Every reply comes from Drone Hive AI either way.')}
        <div class="row">
          <span class="row-text"><span class="row-title">Creativity (temperature)</span><span class="row-sub">Lower is more focused, higher is more creative.</span></span>
          <div class="temp-control">
            <label class="mini-check"><input type="checkbox" data-action="temp-default" ${s.temperature == null ? 'checked' : ''}><span>Default</span></label>
            <input type="range" min="0" max="1" step="0.1" value="${s.temperature ?? 0.7}" data-setting="temperature" data-kind="number" ${s.temperature == null ? 'disabled' : ''} aria-label="Temperature">
            <output>${s.temperature == null ? '—' : Number(s.temperature).toFixed(1)}</output>
          </div>
        </div>
        <label class="row">
          <span class="row-text"><span class="row-title">Response length</span><span class="row-sub">The most each reply can use. Longer replies use more of your token allowance.</span></span>
          <select class="input input-sm" data-setting="responseLength">
            <option value="short" ${s.responseLength === 'short' ? 'selected' : ''}>Short — up to ${lengths.short.toLocaleString()} tokens</option>
            <option value="medium" ${s.responseLength !== 'short' ? 'selected' : ''}>Medium — up to ${lengths.medium.toLocaleString()} tokens</option>
          </select>
        </label>
      </div>

      <div class="group">
        <div class="group-label">Custom instructions</div>
        <p class="group-note">${icon('info', { size: 15 })}<span>Added to every conversation, on top of Drone Hive AI's built-in personality. Example: “I mostly code in JavaScript. Keep answers short.”</span></p>
        <textarea class="input textarea" rows="4" maxlength="${status?.limits?.maxCustomInstructionChars || 2000}" placeholder="Tell Drone Hive AI how to respond…" data-setting="customInstructions" data-kind="text" ${status && status.customInstructionsAllowed === false ? 'disabled' : ''}>${escapeHtml(s.customInstructions)}</textarea>
      </div>`;
  }

  /** Today's usage, as last reported by the server (limits are enforced there). */
  #usageCard() {
    const q = this.getQuota();
    if (!q) {
      return `<div class="usage-card is-empty">${icon('gauge', { size: 17 })}<span>Your usage appears here after your first message. Limits are set and enforced by the server, and every AI counts toward the same limits.</span></div>`;
    }
    const pct = (a, b) => Math.min(100, Math.round((a / Math.max(1, b)) * 100));
    const reset = new Date(q.resetAt);
    const resetText = Number.isNaN(reset.getTime()) ? '' : `Day resets ${reset.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
    const bar = (label, used, limit, p) => `<div class="usage-row">
        <div class="usage-top"><span>${label}</span><span>${used.toLocaleString()} / ${limit.toLocaleString()}</span></div>
        <div class="usage-bar ${p >= 90 ? 'is-high' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${label}"><span data-pct="${p}"></span></div>
      </div>`;
    return `<div class="usage-card">
      <div class="usage-head"><b>${icon('gauge', { size: 16 })}Your usage</b><span>${escapeHtml(resetText)}</span></div>
      ${bar('Messages today', q.requestsUsed, q.requestsLimit, pct(q.requestsUsed, q.requestsLimit))}
      ${bar('Tokens today', q.tokensUsed, q.tokensLimit, pct(q.tokensUsed, q.tokensLimit))}
      ${Number.isFinite(q.weekTokensLimit) ? bar('Tokens this week', q.weekTokensUsed, q.weekTokensLimit, pct(q.weekTokensUsed, q.weekTokensLimit)) : ''}
      ${Number.isFinite(q.monthTokensLimit) ? bar('Tokens this month', q.monthTokensUsed, q.monthTokensLimit, pct(q.monthTokensUsed, q.monthTokensLimit)) : ''}
      ${q.weekResetAt ? `<p class="usage-note">Daily limits reset at midnight UTC, weekly on Monday, monthly on the 1st.</p>` : ''}
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
            ? 'Conversations, settings and attached images are saved only in this browser. They are not stored on the Drone Hive server (memories are managed separately in Settings → Memory). Only the messages (and images) you send are passed through the server to the AI provider to generate a reply. Images are shrunk and cleaned of hidden data such as GPS location before sending. Clearing your browser data or using another device will not show these chats.'
            : 'Your browser is blocking local storage (for example in private mode), so conversations will be lost when this tab closes.'
        }</span></p>
      </div>

      <div class="group">
        <div class="group-label">Export</div>
        <div class="row">
          <span class="row-text"><span class="row-title">Export all conversations</span><span class="row-sub">Download everything as a JSON file (attached images aren’t included).</span></span>
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
        <img class="logo-ink about-logo" src="/assets/brand/logo-full.png" alt="Drone Hive Studios" width="774" height="503">
        <div class="about-tags"><span>Websites</span><i></i><span>Bots</span><i></i><span>Games</span></div>
      </div>
      <div class="group">
        <div class="group-label">Contact us</div>
        <div class="contact-card">
          <span class="contact-icon">${icon('mail', { size: 20 })}</span>
          <div class="contact-text">
            <b>Questions, feedback or a problem?</b>
            <span>Email the Drone Hive Studios team — we read every message.</span>
            <a class="contact-email" href="${escapeHtml(contactLink('Drone Hive AI — question or feedback'))}">${escapeHtml(APP.email)}</a>
          </div>
          <div class="contact-actions">
            <a class="btn btn-sm btn-primary" href="${escapeHtml(contactLink('Drone Hive AI — question or feedback'))}">${icon('mail', { size: 14 })}<span>Email us</span></a>
            <button type="button" class="btn btn-sm btn-secondary" data-action="copy-email">${icon('copy', { size: 14 })}<span>Copy address</span></button>
          </div>
        </div>
        <p class="group-foot">“Email us” opens your own email app with a new message. Drone Hive AI doesn’t send email on your behalf.</p>
      </div>
      <div class="group">
        <div class="group-label">Drone Hive AI</div>
        <div class="row"><span class="row-text"><span class="row-title">Version</span></span><span class="chip">v${APP.version}</span></div>
        <div class="row"><span class="row-text"><span class="row-title">Developer</span></span><span class="chip">${escapeHtml(APP.studio)}</span></div>
        <p class="about-text">Drone Hive AI is the AI assistant built and owned by Drone Hive Studios, made to help with code, ideas and writing. It securely connects to leading AI models behind the scenes, can remember what matters to you (with your permission), and keeps your conversations on your own device.</p>
      </div>
      <div class="group">
        <div class="group-label">Credits</div>
        <p class="about-text"><b>${escapeHtml(APP.credits)}</b></p>
        <p class="about-text muted">Built with plain HTML, CSS and JavaScript and Netlify Edge Functions — no frameworks, no tracking.</p>
      </div>`;
  }

  #memory() {
    const s = this.settings.all();
    const m = this.memory;
    const account = m?.store === 'account';
    const signedInAs = this.auth?.signedIn ? this.auth.user?.email : '';
    const where = account
      ? 'Saved to your account — private to you and available wherever you sign in.'
      : signedInAs
        ? `Saved in this browser for ${escapeHtml(signedInAs)}.`
        : 'Saved in this browser on this device.';
    const items = m?.items || [];
    const q = this.memQuery.trim().toLowerCase();
    const shown = q ? items.filter((x) => x.text.toLowerCase().includes(q)) : items;
    const categoryOptions = (selected) =>
      Object.entries(MEMORY_CATEGORIES)
        .map(([k, label]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${label}</option>`)
        .join('');

    let list;
    if (!m || m.state === 'locked') list = '<p class="muted">Sign in to see your memories.</p>';
    else if (m.state === 'loading' && !items.length) list = '<div class="mem-loading" role="status"><span class="spinner" aria-hidden="true"></span>Loading your memories…</div>';
    else if (m.state === 'error')
      list = `<div class="mem-error" role="alert">${icon('alert', { size: 16 })}<span>${escapeHtml(m.error || 'Memories couldn’t be loaded.')}</span><button type="button" class="btn btn-sm btn-secondary" data-action="mem-retry">Try again</button></div>`;
    else if (!items.length)
      list = `<div class="mem-empty">${icon('brain', { size: 22 })}<p><b>No memories yet.</b> Tell Drone Hive AI about yourself, your projects or how you like answers — or add something above.</p></div>`;
    else if (!shown.length) list = `<p class="muted">No memories match “${escapeHtml(this.memQuery.trim())}”.</p>`;
    else {
      const groups = Object.keys(MEMORY_CATEGORIES)
        .map((cat) => [cat, shown.filter((x) => x.category === cat).sort((a, b) => b.updatedAt - a.updatedAt)])
        .filter(([, list]) => list.length);
      list = groups
        .map(
          ([cat, group]) => `<div class="mem-group">
            <div class="mem-group-label">${MEMORY_CATEGORIES[cat]}</div>
            ${group
              .map((x) =>
                this.memEditId === x.id
                  ? `<form class="mem-item mem-edit" data-form="memory-edit" data-id="${escapeHtml(x.id)}">
                      <textarea class="input textarea" name="text" rows="2" maxlength="${MEMORY_LIMITS.maxChars}" aria-label="Edit memory">${escapeHtml(x.text)}</textarea>
                      <div class="mem-edit-bar">
                        <select class="input input-sm" name="category" aria-label="Category">${categoryOptions(x.category)}</select>
                        <span class="mem-edit-btns">
                          <button type="button" class="btn btn-sm btn-ghost" data-action="mem-cancel">Cancel</button>
                          <button type="submit" class="btn btn-sm btn-primary">Save</button>
                        </span>
                      </div>
                    </form>`
                  : `<div class="mem-item" data-id="${escapeHtml(x.id)}">
                      <div class="mem-body">
                        <p class="mem-text">${escapeHtml(x.text)}</p>
                        <span class="mem-meta">${x.source === 'manual' ? 'Added by you' : 'Learned in chat'} · ${formatDateTime(x.updatedAt)}</span>
                      </div>
                      <div class="mem-actions">
                        <button type="button" class="icon-btn" data-action="mem-edit" data-id="${escapeHtml(x.id)}" aria-label="Edit memory: ${escapeHtml(x.text)}" title="Edit">${icon('pencil', { size: 16 })}</button>
                        <button type="button" class="icon-btn icon-btn-danger" data-action="mem-delete" data-id="${escapeHtml(x.id)}" aria-label="Delete memory: ${escapeHtml(x.text)}" title="Delete">${icon('trash', { size: 16 })}</button>
                      </div>
                    </div>`,
              )
              .join('')}
          </div>`,
        )
        .join('');
    }
    const canEdit = m && m.state !== 'locked' && m.state !== 'error';
    const importable = account ? m.localCount : 0;

    return `
      <h3 class="section-title">Memory</h3>
      <p class="section-sub">Drone Hive AI can remember useful things about you between conversations, so you don’t have to repeat yourself.</p>

      <label class="memory-hero ${s.memoryEnabled ? 'is-on' : ''}">
        <span class="memory-hero-icon">${icon('brain', { size: 20 })}</span>
        <span class="memory-hero-text"><b>${s.memoryEnabled ? 'Memory is on' : 'Memory is off'}</b><span>${s.memoryEnabled ? where : 'Nothing new is saved, and saved memories aren’t used in chats.'}</span></span>
        <span class="switch"><input type="checkbox" data-setting="memoryEnabled" aria-label="Use memory" ${s.memoryEnabled ? 'checked' : ''}><span class="switch-track"><span class="switch-thumb"></span></span></span>
      </label>

      <div class="group${s.memoryEnabled ? '' : ' is-dim'}">
        <div class="group-label">What gets remembered</div>
        ${toggleRow('memoryAuto', s.memoryAuto, 'Save memories automatically', 'Picks up useful details as you chat — your name, projects, coding languages, tools and preferences. When off, it only saves something when you say “remember …”.')}
        ${toggleRow('memoryRecentChats', s.memoryRecentChats, 'Reference recent chats', 'Lets Drone Hive AI see the titles of your recent conversations, so it notices when you return to a project.')}
      </div>

      <div class="group">
        <div class="group-label mem-head"><span>Saved memories</span><span class="mem-count">${items.length} / ${MEMORY_LIMITS.maxItems}</span></div>
        ${
          canEdit
            ? `<form class="mem-add" data-form="memory-add">
                <input class="input" name="text" type="text" maxlength="${MEMORY_LIMITS.maxChars}" placeholder="Add something to remember…" aria-label="New memory" value="${escapeHtml(this.memDraft)}" autocomplete="off">
                <div class="mem-add-bar">
                  <select class="input input-sm" name="category" aria-label="Category">${categoryOptions('about')}</select>
                  <button type="submit" class="btn btn-sm btn-primary">${icon('plus', { size: 14 })}<span>Add memory</span></button>
                </div>
              </form>`
            : ''
        }
        ${items.length > 6 ? `<input class="input input-sm mem-search" type="search" placeholder="Search memories" aria-label="Search memories" value="${escapeHtml(this.memQuery)}" data-mem-search>` : ''}
        <div class="mem-list">${list}</div>
        ${
          importable
            ? `<div class="row"><span class="row-text"><span class="row-title">Memories in this browser</span><span class="row-sub">${importable} memor${importable === 1 ? 'y was' : 'ies were'} saved in this browser before account storage was turned on.</span></span><button type="button" class="btn btn-sm btn-secondary" data-action="mem-import">${icon('download', { size: 14 })}<span>Copy to account</span></button></div>`
            : ''
        }
      </div>

      <div class="group">
        <div class="group-label">How memory works</div>
        <ul class="memory-explain">
          <li>${icon('sparkle', { size: 16 })}<span><b>It learns as you chat.</b> When you share something useful for later, Drone Hive AI saves a short note and shows “Memory updated” on its reply. You can also say “remember …” or “forget …”.</span></li>
          <li>${icon('search', { size: 16 })}<span><b>Only what’s relevant is used.</b> Notes are added to a conversation only when they help with what you’re asking. Drone Hive AI never pretends to remember things that weren’t saved.</span></li>
          <li>${icon('pencil', { size: 16 })}<span><b>You’re in control.</b> View, edit or delete anything here, or turn memory off at any time.</span></li>
          <li>${icon('shield', { size: 16 })}<span><b>Secrets are never saved.</b> Passwords, API keys, tokens and card numbers are refused automatically.</span></li>
          <li>${icon('database', { size: 16 })}<span><b>Where it’s kept.</b> ${
            account
              ? 'Your memories are stored with your account on the Drone Hive AI server. Other accounts can never see them.'
              : 'Your memories are stored in this browser only, separately for each account. Clearing this site’s data deletes them.'
          } Relevant notes are sent with your messages to the AI that writes the reply.</span></li>
        </ul>
      </div>

      <div class="group danger-zone">
        <div class="group-label">Manage</div>
        <div class="row">
          <span class="row-text"><span class="row-title">Download memories</span><span class="row-sub">Save a copy of everything Drone Hive AI remembers as a JSON file.</span></span>
          <button type="button" class="btn btn-sm btn-secondary" data-action="mem-export" ${items.length ? '' : 'disabled'}>${icon('download', { size: 14 })}<span>Download</span></button>
        </div>
        <div class="row">
          <span class="row-text"><span class="row-title">Clear all memories</span><span class="row-sub">Permanently deletes everything Drone Hive AI remembers about you${account ? ' on every device' : ' in this browser'}.</span></span>
          <button type="button" class="btn btn-sm btn-danger" data-action="mem-clear" ${items.length && canEdit ? '' : 'disabled'}>${icon('trash', { size: 14 })}<span>Clear all</span></button>
        </div>
      </div>`;
  }

  async #onSubmit(e) {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    const text = form.elements.text?.value || '';
    const category = form.elements.category?.value;
    if (btn) btn.disabled = true;
    let result;
    if (form.dataset.form === 'memory-add') {
      if (!text.trim()) {
        if (btn) btn.disabled = false;
        form.elements.text.focus();
        return;
      }
      result = await this.memory.add(text, category);
      if (result.ok) {
        this.memDraft = '';
        toast('Memory saved', { type: 'success' });
        this.#renderSection();
        this.el?.querySelector('.mem-add input')?.focus();
        return;
      }
    } else if (form.dataset.form === 'memory-edit') {
      result = await this.memory.update(form.dataset.id, { text, category });
      if (result.ok) {
        this.memEditId = null;
        toast('Memory updated', { type: 'success' });
        this.#renderSection();
        return;
      }
    }
    if (btn) btn.disabled = false;
    if (result && !result.ok) {
      // Don't leave a password or key sitting on screen.
      if (result.sensitive && form.elements.text) {
        form.elements.text.value = '';
        if (form.dataset.form === 'memory-add') this.memDraft = '';
      }
      toast(result.message, { type: 'error', duration: 5000 });
    }
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
      case 'sign-out':
        await this.actions.signOut();
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
      case 'copy-email':
        if (await copyText(APP.email)) toast('Email address copied', { type: 'success' });
        else toast(APP.email);
        break;
      case 'mem-edit':
        this.memEditId = btn.dataset.id;
        this.#renderSection();
        break;
      case 'mem-cancel':
        this.memEditId = null;
        this.#renderSection();
        break;
      case 'mem-delete': {
        const r = await this.memory.remove(btn.dataset.id);
        toast(r.ok ? 'Memory deleted' : r.message, { type: r.ok ? 'success' : 'error' });
        break;
      }
      case 'mem-clear': {
        const ok = await confirmDialog({
          title: 'Clear all memories?',
          body: 'Drone Hive AI will forget everything it has saved about you. This can’t be undone.',
          confirmText: 'Clear memories',
          danger: true,
        });
        if (!ok) break;
        const r = await this.memory.clear();
        toast(r.ok ? 'All memories cleared' : r.message, { type: r.ok ? 'success' : 'error' });
        break;
      }
      case 'mem-export':
        this.actions.exportMemories();
        break;
      case 'mem-import': {
        btn.disabled = true;
        const r = await this.memory.importLocal();
        toast(r.message, { type: r.ok ? 'success' : 'error' });
        this.#renderSection();
        break;
      }
      case 'mem-retry':
        this.memory.reload();
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
    if (t.type === 'checkbox') {
      this.settings.set(key, t.checked);
      if (this.section === 'memory') this.#renderSection();
    }
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
    if (t.closest('.mem-add') && t.name === 'text') {
      this.memDraft = t.value;
      return;
    }
    if (t.dataset.memSearch !== undefined) {
      this.memQuery = t.value;
      const pos = t.selectionStart;
      this.#renderSection();
      const again = this.el?.querySelector('[data-mem-search]');
      again?.focus();
      again?.setSelectionRange(pos, pos);
      return;
    }
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


import { $ } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './overlays.js';
import { AI_MODES } from '../config.js';

/** Providers in the order Automatic mode uses them. */
const MAIN = ['gemini', 'openrouter', 'groq', 'ollama'];

/**
 * Top-bar AI picker: Default, Automatic, or a specific provider.
 * Also shows the connection state (coloured dot).
 */
export class ModelPicker {
  constructor({ settings, connection, actions }) {
    this.settings = settings;
    this.connection = connection;
    this.actions = actions; // { openSettings }
    this.btn = $('#model-pill');
    this.btn.addEventListener('click', () => this.open());
  }

  /** The user's choice, falling back to Default if that provider disappeared. */
  get choice() {
    const v = this.settings.get('provider');
    if (v === 'default' || v === 'automatic') return v;
    const p = this.connection.providers.find((x) => x.id === v);
    return p?.configured ? v : this.connection.status ? 'default' : v;
  }

  label() {
    const c = this.choice;
    if (AI_MODES[c]) return AI_MODES[c].label;
    return this.connection.providers.find((p) => p.id === c)?.shortName || 'Default';
  }

  /** Whether the current choice can read images. */
  get canSeeImages() {
    const status = this.connection.status;
    if (!status?.vision) return false;
    const c = this.choice;
    if (c === 'automatic' || c === 'default') return true; // Default falls back to an image-capable provider
    return Boolean(this.connection.providers.find((p) => p.id === c)?.capabilities?.vision);
  }

  render() {
    const { state } = this.connection;
    const labels = { checking: 'Checking…', disconnected: 'AI not connected', offline: 'Server offline' };
    this.btn.dataset.state = state;
    this.btn.querySelector('.model-pill-label').textContent = state === 'connected' ? this.label() : labels[state];
    const active = this.connection.activeProvider;
    this.btn.title =
      state === 'connected'
        ? this.choice === 'default'
          ? `Default mode — ${active?.name || 'standard AI'}`
          : this.choice === 'automatic'
            ? 'Automatic mode — picks the best AI for each message'
            : `Always use ${this.label()}`
        : 'Open AI settings';
    this.btn.setAttribute('aria-label', `AI: ${this.btn.querySelector('.model-pill-label').textContent}. Change AI`);
  }

  open() {
    if (this.connection.state !== 'connected') return this.actions.openSettings('ai');
    const c = this.choice;
    const providers = this.connection.providers;
    const active = this.connection.activeProvider;
    const set = (v) => {
      this.settings.set('provider', v);
      if (v !== c) this.settings.set('model', '');
    };
    const listed = [
      ...MAIN.map((id) => providers.find((p) => p.id === id)).filter(Boolean),
      ...providers.filter((p) => !MAIN.includes(p.id) && p.configured),
    ];
    showMenu(
      this.btn,
      [
        { header: 'Mode' },
        {
          label: AI_MODES.default.label,
          description: active ? `${AI_MODES.default.description} (${active.shortName || active.name})` : AI_MODES.default.description,
          icon: 'hex',
          checked: c === 'default',
          onSelect: () => set('default'),
        },
        { label: AI_MODES.automatic.label, description: AI_MODES.automatic.description, icon: 'sparkle', checked: c === 'automatic', onSelect: () => set('automatic') },
        { separator: true },
        { header: 'Always use' },
        ...listed.map((p) => ({
          label: p.name,
          description: !p.configured ? 'Not connected on this server' : p.capabilities?.vision ? 'Text and images' : 'Text only',
          icon: 'cpu',
          checked: c === p.id,
          disabled: !p.configured,
          onSelect: () => set(p.id),
        })),
        { separator: true },
        { label: 'AI settings', icon: 'settings', onSelect: () => this.actions.openSettings('ai') },
      ],
      { title: 'Choose an AI', className: 'menu-models' },
    );
  }
}

export function modelPillHTML() {
  return `<span class="status-dot"></span><span class="model-pill-label">Checking…</span>${icon('chevronDown', { size: 15 })}`;
}

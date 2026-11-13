import { Emitter } from './emitter.js';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, STORAGE_KEYS } from '../config.js';

/**
 * One-time upgrades of saved settings. Returns true if anything changed.
 *  v2 (Drone Hive AI 0.4): Automatic becomes the standard AI mode. Everyone on
 *     the old standard ("Default", or the v0.1 name "auto") moves to Automatic.
 *     A provider someone picked by hand is kept. The old "max response length"
 *     number becomes Short / Medium.
 */
function migrate(state) {
  const from = Number(state.settingsVersion) || 1;
  if (from >= SETTINGS_VERSION) return false;
  if (!state.provider || state.provider === 'auto' || state.provider === 'default') {
    state.provider = 'automatic';
    state.model = '';
  }
  if ('maxTokens' in state) {
    state.responseLength = typeof state.maxTokens === 'number' && state.maxTokens <= 2048 ? 'short' : 'medium';
    delete state.maxTokens;
  }
  if (state.responseLength !== 'short' && state.responseLength !== 'medium') state.responseLength = 'medium';
  state.settingsVersion = SETTINGS_VERSION;
  return true;
}

export class SettingsStore extends Emitter {
  constructor(storage) {
    super();
    this.storage = storage;
    const saved = storage.load(STORAGE_KEYS.settings, {});
    this.state = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
    if (migrate(this.state)) storage.save(STORAGE_KEYS.settings, this.state);
  }

  get(key) {
    return this.state[key];
  }

  all() {
    return { ...this.state };
  }

  set(key, value) {
    if (this.state[key] === value) return;
    this.state[key] = value;
    this.storage.save(STORAGE_KEYS.settings, this.state);
    this.emit('change', { key, value });
  }

  reset() {
    this.state = { ...DEFAULT_SETTINGS, settingsVersion: SETTINGS_VERSION };
    this.storage.save(STORAGE_KEYS.settings, this.state);
    this.emit('change', { key: '*', value: null });
  }
}

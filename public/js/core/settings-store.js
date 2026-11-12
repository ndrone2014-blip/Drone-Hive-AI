import { Emitter } from './emitter.js';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../config.js';

export class SettingsStore extends Emitter {
  constructor(storage) {
    super();
    this.storage = storage;
    const saved = storage.load(STORAGE_KEYS.settings, {});
    this.state = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
    // v0.1 used "auto" for what is now called "default".
    if (this.state.provider === 'auto' || !this.state.provider) this.state.provider = 'default';
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
    this.state = { ...DEFAULT_SETTINGS };
    this.storage.save(STORAGE_KEYS.settings, this.state);
    this.emit('change', { key: '*', value: null });
  }
}

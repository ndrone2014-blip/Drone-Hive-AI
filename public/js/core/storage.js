/**
 * Storage adapter. Everything is saved in this browser's localStorage today.
 *
 * FUTURE (user accounts / conversation sync): create another adapter with the
 * same methods (load, save, remove, usage) that talks to a backend, and pass
 * it to the stores in main.js instead of LocalStorageAdapter.
 */
export class LocalStorageAdapter {
  constructor() {
    this.available = (() => {
      try {
        const k = '__dhai_test__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return true;
      } catch {
        return false;
      }
    })();
    this.memory = new Map(); // fallback when storage is blocked (private mode etc.)
  }

  load(key, fallback = null) {
    try {
      const raw = this.available ? localStorage.getItem(key) : this.memory.get(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (err) {
      console.warn(`[storage] Could not read "${key}", using defaults.`, err);
      return fallback;
    }
  }

  /** Returns true on success, false if the browser refused (e.g. storage full). */
  save(key, value) {
    const raw = JSON.stringify(value);
    if (!this.available) {
      this.memory.set(key, raw);
      return true;
    }
    try {
      localStorage.setItem(key, raw);
      return true;
    } catch (err) {
      console.error(`[storage] Could not save "${key}".`, err);
      return false;
    }
  }

  remove(key) {
    try {
      if (this.available) localStorage.removeItem(key);
      else this.memory.delete(key);
    } catch {
      /* ignore */
    }
  }

  /** Approximate bytes used by the given keys. */
  usage(keys) {
    let bytes = 0;
    for (const k of keys) {
      const raw = this.available ? localStorage.getItem(k) : this.memory.get(k);
      if (raw) bytes += raw.length * 2; // UTF-16
    }
    return bytes;
  }
}

import { Emitter } from '../core/emitter.js';
import { fetchStatus } from './ai-client.js';

/**
 * Tracks whether the backend and an AI provider are available.
 * Checks on startup, when the tab regains focus (at most once a minute) and
 * on demand — no constant background polling.
 *
 * state: 'checking' | 'connected' | 'disconnected' | 'offline'
 */
export class ConnectionService extends Emitter {
  constructor() {
    super();
    this.state = 'checking';
    this.status = null;
    this.lastCheck = 0;
    this.inflight = null;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - this.lastCheck > 60_000) this.refresh();
    });
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    this.#set('checking', this.status);
    this.inflight = fetchStatus()
      .then((status) => {
        this.lastCheck = Date.now();
        const state = !status.reachable ? 'offline' : status.connected ? 'connected' : 'disconnected';
        this.#set(state, status);
        return status;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Called after a chat request reveals the real state (e.g. provider not configured). */
  markFromError(code) {
    if (code === 'BACKEND_UNAVAILABLE') this.#set('offline', this.status);
    else if (code === 'PROVIDER_NOT_CONFIGURED') this.#set('disconnected', this.status);
  }

  #set(state, status) {
    this.state = state;
    this.status = status;
    this.emit('change', { state, status });
  }

  get providers() {
    return this.status?.providers || [];
  }

  get activeProvider() {
    return this.providers.find((p) => p.id === this.status?.activeProvider) || null;
  }
}

import { App } from './app.js';

/** Entry point. */
function start() {
  try {
    window.droneHiveAI = new App();
  } catch (err) {
    console.error('[Drone Hive AI] Failed to start', err);
    const el = document.getElementById('chat-content');
    if (el) {
      el.innerHTML =
        '<div class="fatal"><h2>Drone Hive AI couldn’t start</h2><p>Try refreshing the page. If this keeps happening, clear this site’s data in your browser settings.</p></div>';
    }
  }
}

/** Home Screen app support: offline launch + fast start. Never caches AI requests. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => console.warn('[Drone Hive AI] Offline support unavailable', err));
  });
}
registerServiceWorker();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

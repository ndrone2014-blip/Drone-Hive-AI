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

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

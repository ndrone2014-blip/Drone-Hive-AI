import { html, escapeHtml } from './dom.js';
import { icon } from './icons.js';

/* ── Toasts ───────────────────────────────────────────────── */
let toastRoot;
export function toast(message, { type = 'info', duration = 2600 } = {}) {
  if (!toastRoot) {
    toastRoot = html('<div class="toast-root" role="status" aria-live="polite"></div>');
    document.body.appendChild(toastRoot);
  }
  const ico = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info';
  const el = html(`<div class="toast toast-${type}">${icon(ico, { size: 16 })}<span>${escapeHtml(message)}</span></div>`);
  toastRoot.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

/* ── Dialogs (confirm / prompt) ───────────────────────────── */
function openDialog({ title, body, confirmText = 'Confirm', danger = false, input = null }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const el = html(`
      <div class="dialog-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
          <h3 id="dlg-title">${escapeHtml(title)}</h3>
          ${body ? `<p class="dialog-body">${escapeHtml(body)}</p>` : ''}
          ${input ? `<input class="input" type="text" maxlength="${input.maxLength || 120}" value="${escapeHtml(input.value || '')}" aria-label="${escapeHtml(input.label || title)}">` : ''}
          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmText)}</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(el);
    const field = el.querySelector('input');
    const ok = el.querySelector('[data-act="ok"]');
    requestAnimationFrame(() => {
      el.classList.add('show');
      if (field) {
        field.focus();
        field.select();
      } else ok.focus();
    });

    const close = (result) => {
      el.classList.remove('show');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(() => el.remove(), 180);
      previous?.focus?.();
      resolve(result);
    };
    const submit = () => close(input ? field.value : true);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(input ? null : false);
      } else if (e.key === 'Enter' && (field ? document.activeElement === field : true)) {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    el.addEventListener('mousedown', (e) => {
      if (e.target === el) close(input ? null : false);
    });
    el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(input ? null : false));
    ok.addEventListener('click', submit);
  });
}

export const confirmDialog = (opts) => openDialog(opts);
export const promptDialog = ({ title, value, label, confirmText = 'Save' }) =>
  openDialog({ title, confirmText, input: { value, label } });

/* ── Popover menu ─────────────────────────────────────────── */
let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.el.remove();
    openMenu.anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', openMenu.onDoc, true);
    document.removeEventListener('keydown', openMenu.onKey, true);
    openMenu = null;
  }
}

/** items: [{ label, icon, danger, onSelect }] */
export function showMenu(anchor, items) {
  const wasOpenForAnchor = openMenu?.anchor === anchor;
  closeMenu();
  if (wasOpenForAnchor) return;
  const el = html(`<div class="menu" role="menu">${items
    .map((it, i) => `<button type="button" role="menuitem" class="menu-item${it.danger ? ' danger' : ''}" data-i="${i}">${icon(it.icon, { size: 16 })}<span>${escapeHtml(it.label)}</span></button>`)
    .join('')}</div>`);
  document.body.appendChild(el);

  const r = anchor.getBoundingClientRect();
  const mw = el.offsetWidth;
  const mh = el.offsetHeight;
  let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
  left = Math.max(8, left);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 6;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  anchor.setAttribute('aria-expanded', 'true');

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-i]');
    if (!btn) return;
    const item = items[Number(btn.dataset.i)];
    closeMenu();
    item.onSelect();
  });
  const onDoc = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      anchor.focus();
    }
  };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  openMenu = { el, anchor, onDoc, onKey };
  el.querySelector('button')?.focus();
}

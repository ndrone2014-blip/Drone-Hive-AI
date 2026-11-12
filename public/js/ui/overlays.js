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
    el.addEventListener('pointerdown', (e) => {
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
const SHEET_QUERY = matchMedia('(max-width: 640px), (pointer: coarse) and (max-width: 860px)');
let openMenu = null;
export function closeMenu() {
  if (!openMenu) return;
  const { el, anchor, onDoc, onKey, onResize, backdrop } = openMenu;
  openMenu = null;
  anchor.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onDoc, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  el.classList.remove('show');
  backdrop?.classList.remove('show');
  setTimeout(() => {
    el.remove();
    backdrop?.remove();
  }, 160);
}

/**
 * items: [{ label, icon, description, checked, disabled, danger, onSelect }]
 *        or { header: 'Text' } or { separator: true }
 * On phones the menu opens as a bottom sheet with large touch targets.
 */
export function showMenu(anchor, items, { title = '', className = '' } = {}) {
  const wasOpenForAnchor = openMenu?.anchor === anchor;
  closeMenu();
  if (wasOpenForAnchor) return;
  const sheet = SHEET_QUERY.matches;
  const body = items
    .map((it, i) => {
      if (it.separator) return '<div class="menu-sep" role="separator"></div>';
      if (it.header) return `<div class="menu-header">${escapeHtml(it.header)}</div>`;
      const cls = ['menu-item', it.danger && 'danger', it.checked && 'checked', it.description && 'has-desc'].filter(Boolean).join(' ');
      return `<button type="button" role="${it.checked === undefined ? 'menuitem' : 'menuitemradio'}" ${it.checked !== undefined ? `aria-checked="${Boolean(it.checked)}"` : ''} class="${cls}" data-i="${i}" ${it.disabled ? 'disabled aria-disabled="true"' : ''}>
        ${it.icon ? icon(it.icon, { size: 17 }) : ''}
        <span class="menu-text"><span class="menu-label">${escapeHtml(it.label)}</span>${it.description ? `<span class="menu-desc">${escapeHtml(it.description)}</span>` : ''}</span>
        ${it.checked ? `<span class="menu-check">${icon('check', { size: 16 })}</span>` : ''}
      </button>`;
    })
    .join('');
  const el = html(`<div class="menu ${sheet ? 'menu-sheet' : ''} ${className}" role="menu" ${title ? `aria-label="${escapeHtml(title)}"` : ''}>
    ${sheet ? `<div class="sheet-grip" aria-hidden="true"></div>${title ? `<div class="sheet-title">${escapeHtml(title)}</div>` : ''}` : ''}
    <div class="menu-body">${body}</div></div>`);
  let backdrop = null;
  if (sheet) {
    backdrop = html('<div class="sheet-backdrop"></div>');
    document.body.appendChild(backdrop);
  }
  document.body.appendChild(el);

  const place = () => {
    if (sheet) return;
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth;
    const mh = el.offsetHeight;
    let left = Math.min(r.right - mw, window.innerWidth - mw - 8);
    left = Math.max(8, left);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  place();
  anchor.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    el.classList.add('show');
    backdrop?.classList.add('show');
  });

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-i]');
    if (!btn || btn.disabled) return;
    const item = items[Number(btn.dataset.i)];
    closeMenu();
    item.onSelect?.();
  });
  const onDoc = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) {
      // Swallow the tap that closes a sheet so it doesn't also press something underneath.
      if (sheet) {
        e.preventDefault();
        e.stopPropagation();
      }
      closeMenu();
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeMenu();
      anchor.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const btns = [...el.querySelectorAll('button:not([disabled])')];
      const i = btns.indexOf(document.activeElement);
      btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
    }
  };
  const onResize = () => (sheet ? null : closeMenu());
  document.addEventListener('pointerdown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  openMenu = { el, anchor, onDoc, onKey, onResize, backdrop };
  if (!sheet || matchMedia('(pointer: fine)').matches) (el.querySelector('.menu-item.checked') || el.querySelector('button:not([disabled])'))?.focus({ preventScroll: true });
}

/* ── Image viewer ─────────────────────────────────────────── */
export function showImage(src, alt = '') {
  const previous = document.activeElement;
  const el = html(`<div class="lightbox" role="dialog" aria-modal="true" aria-label="Image preview">
    <img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">
    <button type="button" class="icon-btn lightbox-close" aria-label="Close preview">${icon('x')}</button>
  </div>`);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 180);
    previous?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('.lightbox-close')) close();
  });
  el.querySelector('.lightbox-close').focus();
}

import { $, escapeHtml, dateGroup, initials } from './dom.js';
import { icon } from './icons.js';
import { showMenu } from './overlays.js';

const MOBILE_QUERY = matchMedia('(max-width: 860px)');

/**
 * Left sidebar: brand, new chat, search, grouped history, profile, settings,
 * collapse/expand (desktop) and drawer (mobile).
 */
export class Sidebar {
  constructor({ store, settings, actions }) {
    this.store = store;
    this.settings = settings;
    this.actions = actions; // { select, newChat, rename, delete, exportMarkdown, openSettings }
    this.query = '';
    this.renamingId = null;

    this.el = $('#sidebar');
    this.list = $('#conv-list');
    this.search = $('#search-input');

    $('#sidebar-collapse').innerHTML = icon('sidebar');
    $('#sidebar-expand').innerHTML = icon('sidebar');
    $('#topbar-new-chat').innerHTML = icon('plus');
    $('#new-chat').innerHTML = `${icon('plus', { size: 17 })}<span>New chat</span>`;
    $('.search-icon').innerHTML = icon('search', { size: 16 });
    $('#settings-btn').innerHTML = icon('settings');

    this.#bind();
    this.render();
    this.renderProfile();
  }

  #bind() {
    $('#new-chat').addEventListener('click', () => {
      this.actions.newChat();
      this.closeMobile();
    });
    $('#topbar-new-chat').addEventListener('click', () => this.actions.newChat());
    $('#brand-home').addEventListener('click', (e) => {
      e.preventDefault();
      this.actions.newChat();
      this.closeMobile();
    });
    $('#sidebar-collapse').addEventListener('click', () => this.toggle(false));
    $('#sidebar-expand').addEventListener('click', () => this.toggle(true));
    $('#sidebar-backdrop').addEventListener('click', () => this.closeMobile());
    $('#settings-btn').addEventListener('click', () => this.actions.openSettings('general'));
    $('#profile-btn').addEventListener('click', () => (this.account ? this.actions.openSettings('account') : this.actions.openSettings('general', 'displayName')));

    let t;
    this.search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        this.query = this.search.value;
        this.render();
      }, 120);
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.search.value = '';
        this.query = '';
        this.render();
        this.search.blur();
      }
    });

    this.list.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) {
        e.stopPropagation();
        this.#openItemMenu(more, more.dataset.more);
        return;
      }
      const item = e.target.closest('[data-id]');
      if (item && !e.target.closest('input')) {
        this.actions.select(item.dataset.id);
        this.closeMobile();
      }
    });
    this.list.addEventListener('dblclick', (e) => {
      const item = e.target.closest('[data-id]');
      if (item) this.startRename(item.dataset.id);
    });
    this.list.addEventListener('keydown', (e) => {
      const item = e.target.closest('.conv-item');
      if (!item || e.target.tagName === 'INPUT') return;
      if (e.key === 'F2') {
        e.preventDefault();
        this.startRename(item.dataset.id);
      } else if (e.key === 'Delete') {
        e.preventDefault();
        this.actions.delete(item.dataset.id);
      }
    });

    MOBILE_QUERY.addEventListener('change', () => this.closeMobile());
  }

  #openItemMenu(anchor, id) {
    showMenu(anchor, [
      { label: 'Rename', icon: 'pencil', onSelect: () => this.startRename(id) },
      { label: 'Export as Markdown', icon: 'download', onSelect: () => this.actions.exportMarkdown(id) },
      { label: 'Delete', icon: 'trash', danger: true, onSelect: () => this.actions.delete(id) },
    ]);
  }

  /** Collapse/expand. On mobile this opens/closes the drawer instead. */
  toggle(open) {
    if (MOBILE_QUERY.matches) {
      document.documentElement.classList.toggle('sidebar-open', open);
      return;
    }
    document.documentElement.classList.toggle('sidebar-collapsed', !open);
    this.settings.set('sidebarCollapsed', !open);
  }

  closeMobile() {
    document.documentElement.classList.remove('sidebar-open');
  }

  focusSearch() {
    if (MOBILE_QUERY.matches) this.toggle(true);
    else if (document.documentElement.classList.contains('sidebar-collapsed')) this.toggle(true);
    this.search.focus();
    this.search.select();
  }

  startRename(id) {
    const c = this.store.get(id);
    if (!c) return;
    this.renamingId = id;
    this.render();
    const input = this.list.querySelector('.conv-rename');
    if (!input) return;
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      this.renamingId = null;
      if (save) this.actions.rename(id, input.value);
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  render() {
    const results = this.store.search(this.query);
    if (!results.length) {
      this.list.innerHTML = this.query.trim()
        ? `<div class="conv-empty">${icon('search', { size: 20 })}<p>No conversations match “${escapeHtml(this.query.trim())}”.</p></div>`
        : `<div class="conv-empty">${icon('message', { size: 20 })}<p>Your conversations will appear here.</p></div>`;
      return;
    }
    const groups = new Map();
    for (const r of results) {
      const g = this.query.trim() ? 'Results' : dateGroup(r.conversation.updatedAt);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    let out = '';
    for (const [label, items] of groups) {
      out += `<div class="conv-group"><div class="conv-group-label">${label}</div>`;
      for (const { conversation: c, snippet } of items) {
        const active = c.id === this.store.activeId;
        if (c.id === this.renamingId) {
          out += `<div class="conv-item renaming${active ? ' active' : ''}" data-id="${c.id}"><input class="conv-rename" value="${escapeHtml(c.title)}" maxlength="120" aria-label="Conversation name"></div>`;
          continue;
        }
        out += `<div class="conv-item${active ? ' active' : ''}" data-id="${c.id}" role="button" tabindex="0" ${active ? 'aria-current="true"' : ''} title="${escapeHtml(c.title)}">
            <span class="conv-text"><span class="conv-title">${escapeHtml(c.title)}</span>${snippet ? `<span class="conv-snippet">${escapeHtml(snippet)}</span>` : ''}</span>
            <button type="button" class="conv-more" data-more="${c.id}" aria-label="Options for ${escapeHtml(c.title)}" aria-haspopup="menu" aria-expanded="false">${icon('more', { size: 16 })}</button>
          </div>`;
      }
      out += '</div>';
    }
    this.list.innerHTML = out;
  }

  /** Signed-in account (or null). Shown in the profile area when sign-in is on. */
  setAccount(user) {
    this.account = user;
    this.renderProfile();
  }

  renderProfile() {
    const acct = this.account;
    const name = this.settings.get('displayName').trim() || acct?.name || (acct?.email ? acct.email.split('@')[0] : '');
    $('#profile-name').textContent = name || 'Guest';
    $('#profile-sub').textContent = acct ? acct.email || 'Signed in' : 'Local profile';
    const avatar = $('#profile-avatar');
    const ini = initials(name);
    avatar.innerHTML = ini ? escapeHtml(ini) : icon('user', { size: 16 });
  }
}

// Allow keyboard activation of items (Enter / Space)
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('conv-item')) {
    e.preventDefault();
    e.target.click();
  }
});


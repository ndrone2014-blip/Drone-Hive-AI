import { html, escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { toast } from './overlays.js';
import { APP, contactLink } from '../config.js';

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.4-.4-3.5z"/></svg>`;

/**
 * Full-screen sign-in / create-account screen. Shown over the app whenever
 * sign-in is required and the visitor isn't signed in with a verified email.
 */
export class AuthGate {
  constructor({ auth }) {
    this.auth = auth;
    this.mode = 'signin'; // 'signin' | 'signup' | 'reset'
    this.el = null;
    this.busy = false;
    auth.on('change', () => this.update());
    auth.on('error', (msg) => this.#showError(msg));
  }

  update() {
    const { state } = this.auth;
    const show = ['loading', 'signed-out', 'unverified', 'error'].includes(state);
    if (!show) return this.#unmount();
    if (!this.el) this.#mount();
    this.#render();
  }

  #mount() {
    this.el = html(`<div class="auth-gate" role="dialog" aria-modal="true" aria-labelledby="auth-title">
      <div class="auth-stack">
        <div class="auth-card" id="auth-card"></div>
        <p class="auth-help">Need help? Contact Drone Hive Studios at <a href="${escapeHtml(contactLink('Drone Hive AI — sign-in help'))}">${escapeHtml(APP.email)}</a></p>
      </div>
    </div>`);
    document.body.appendChild(this.el);
    document.documentElement.classList.add('auth-locked');
    this.el.addEventListener('submit', (e) => this.#onSubmit(e));
    this.el.addEventListener('click', (e) => this.#onClick(e));
  }

  #unmount() {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    document.documentElement.classList.remove('auth-locked');
  }

  #render() {
    const card = this.el.querySelector('#auth-card');
    const { state, user } = this.auth;
    const head = (title, sub) => `
      <span class="logo-tile logo-tile-lg auth-logo" aria-hidden="true"><img class="logo-ink" src="/assets/brand/emblem.png" alt="" width="576" height="586"></span>
      <h2 id="auth-title">${title}</h2>
      ${sub ? `<p class="auth-sub">${sub}</p>` : ''}`;

    if (state === 'loading') {
      card.innerHTML = `${head('Drone Hive AI', 'Loading sign-in…')}<div class="auth-spinner" aria-hidden="true"></div>`;
      return;
    }
    if (state === 'error') {
      card.innerHTML = `${head('Sign-in couldn’t load', 'Check your internet connection, turn off any blocker for this site, then try again.')}
        <button type="button" class="btn btn-primary auth-wide" data-act="reload">${icon('refresh', { size: 16 })}<span>Try again</span></button>`;
      return;
    }
    if (state === 'unverified') {
      card.innerHTML = `${head('Check your email', `We sent a verification link to <b>${escapeHtml(user?.email || 'your email')}</b>. Click it, then come back here.`)}
        <p class="auth-error" role="alert" hidden></p>
        <button type="button" class="btn btn-primary auth-wide" data-act="verified">${icon('check', { size: 16 })}<span>I’ve verified my email</span></button>
        <button type="button" class="btn btn-secondary auth-wide" data-act="resend">Send the link again</button>
        <p class="auth-foot">Can’t find it? Check spam. Wrong email? <button type="button" class="link-btn" data-act="signout">Sign out</button></p>`;
      return;
    }

    const m = this.mode;
    if (m === 'reset') {
      card.innerHTML = `${head('Reset your password', 'Enter your email and we’ll send you a reset link.')}
        <form class="auth-form" data-form="reset" novalidate>
          <input class="input" type="email" name="email" autocomplete="email" placeholder="Email address" required aria-label="Email address">
          <p class="auth-error" role="alert" hidden></p>
          <button class="btn btn-primary auth-wide" type="submit">Send reset link</button>
        </form>
        <p class="auth-foot"><button type="button" class="link-btn" data-act="mode" data-mode="signin">Back to sign in</button></p>`;
      return;
    }

    const signup = m === 'signup';
    card.innerHTML = `${head(signup ? 'Create your account' : 'Sign in to Drone Hive AI', signup ? 'Free. Accounts keep bots out so the AI stays fast for everyone.' : 'Sign in to start chatting.')}
      <button type="button" class="btn btn-secondary auth-wide auth-google" data-act="google">${GOOGLE_G}<span>Continue with Google</span></button>
      <div class="auth-divider"><span>or use email</span></div>
      <form class="auth-form" data-form="${m}" novalidate>
        ${signup ? '<input class="input" type="text" name="name" autocomplete="name" maxlength="40" placeholder="Name (optional)" aria-label="Name">' : ''}
        <input class="input" type="email" name="email" autocomplete="email" placeholder="Email address" required aria-label="Email address">
        <input class="input" type="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="${signup ? 'Password (8+ characters)' : 'Password'}" required minlength="${signup ? 8 : 1}" aria-label="Password">
        ${signup ? '<input class="input" type="password" name="confirm" autocomplete="new-password" placeholder="Confirm password" required aria-label="Confirm password">' : ''}
        <p class="auth-error" role="alert" hidden></p>
        <button class="btn btn-primary auth-wide" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
      </form>
      ${signup ? '' : '<p class="auth-foot"><button type="button" class="link-btn" data-act="mode" data-mode="reset">Forgot password?</button></p>'}
      <p class="auth-foot">${signup ? 'Already have an account?' : 'New here?'} <button type="button" class="link-btn" data-act="mode" data-mode="${signup ? 'signin' : 'signup'}">${signup ? 'Sign in' : 'Create an account'}</button></p>`;
  }

  #showError(msg) {
    const el = this.el?.querySelector('.auth-error');
    if (!el) return toast(msg, { type: 'error', duration: 5000 });
    el.textContent = msg;
    el.hidden = !msg;
  }

  async #busyRun(btn, fn) {
    if (this.busy) return;
    this.busy = true;
    this.#showError('');
    btn?.setAttribute('disabled', '');
    try {
      await fn();
    } catch (err) {
      this.#showError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      this.busy = false;
      if (btn?.isConnected) btn.removeAttribute('disabled');
    }
  }

  async #onSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('[type="submit"]');
    const f = Object.fromEntries(new FormData(form));
    const email = String(f.email || '').trim();
    const kind = form.dataset.form;

    if (!email) return this.#showError('Enter your email address.');
    if (kind === 'reset') {
      return this.#busyRun(btn, async () => {
        await this.auth.resetPassword(email);
        toast('If that email has an account, a reset link is on its way.', { type: 'success', duration: 5000 });
        this.mode = 'signin';
        this.#render();
      });
    }
    if (!f.password) return this.#showError('Enter your password.');
    if (kind === 'signup') {
      if (String(f.password).length < 8) return this.#showError('Use at least 8 characters for your password.');
      if (f.password !== f.confirm) return this.#showError('The passwords don’t match.');
      return this.#busyRun(btn, () => this.auth.signUp(email, String(f.password), String(f.name || '')));
    }
    return this.#busyRun(btn, () => this.auth.signIn(email, String(f.password)));
  }

  #onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'mode':
        this.mode = btn.dataset.mode;
        this.#render();
        this.el.querySelector('input')?.focus();
        break;
      case 'google':
        this.#busyRun(btn, () => this.auth.signInWithGoogle());
        break;
      case 'verified':
        this.#busyRun(btn, async () => {
          const ok = await this.auth.checkVerified();
          if (!ok) this.#showError('Not verified yet. Click the link in the email, then try again.');
        });
        break;
      case 'resend':
        this.#busyRun(btn, async () => {
          await this.auth.resendVerification();
          toast('Verification email sent.', { type: 'success' });
        });
        break;
      case 'signout':
        this.#busyRun(btn, () => this.auth.signOut());
        break;
      case 'reload':
        location.reload();
        break;
      default:
    }
  }
}

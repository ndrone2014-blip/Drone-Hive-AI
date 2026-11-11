import { Emitter } from '../core/emitter.js';

/**
 * Sign-in with Google or email + password, using Firebase Authentication
 * (free Spark plan). Only loaded when the server says sign-in is required
 * (FIREBASE_API_KEY + FIREBASE_PROJECT_ID set on Netlify).
 *
 * The Firebase SDK is loaded straight from Google's CDN (pinned version), so
 * the project still has no npm dependencies or build step.
 *
 * state: 'off' | 'loading' | 'signed-out' | 'unverified' | 'signed-in' | 'error'
 */
const SDK_VERSION = '13.1.0';
const SDK = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

const FRIENDLY_ERRORS = {
  'auth/invalid-email': 'That email address doesn’t look right.',
  'auth/missing-email': 'Enter your email address.',
  'auth/missing-password': 'Enter your password.',
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/invalid-login-credentials': 'Wrong email or password.',
  'auth/email-already-in-use': 'An account with this email already exists. Try signing in instead.',
  'auth/weak-password': 'Use a stronger password (at least 8 characters).',
  'auth/password-does-not-meet-requirements': 'That password doesn’t meet the requirements. Use 8+ characters with letters and numbers.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/network-request-failed': 'Network problem — check your connection and try again.',
  'auth/popup-closed-by-user': 'The Google sign-in window was closed before finishing.',
  'auth/cancelled-popup-request': 'The Google sign-in window was closed before finishing.',
  'auth/unauthorized-domain': 'This website isn’t on the allowed list in Firebase yet (Authentication → Settings → Authorized domains).',
  'auth/operation-not-allowed': 'This sign-in method isn’t turned on in Firebase yet (Authentication → Sign-in method).',
  'auth/account-exists-with-different-credential': 'This email is already registered with a different sign-in method.',
};

export function friendlyAuthError(err) {
  return FRIENDLY_ERRORS[err?.code] || err?.message?.replace(/^Firebase:\s*/, '') || 'Something went wrong. Please try again.';
}

export class AuthService extends Emitter {
  constructor() {
    super();
    this.state = 'off';
    this.user = null;
    this.fb = null; // { auth, mod }
  }

  get required() {
    return this.state !== 'off';
  }

  get signedIn() {
    return this.state === 'signed-in';
  }

  /** Called with status.auth from /api/status. Safe to call more than once. */
  async init(authStatus) {
    if (!authStatus?.required) {
      if (this.state !== 'off') this.#set('off');
      return;
    }
    if (this.fb || this.initializing) return this.initializing;
    this.#set('loading');
    this.initializing = (async () => {
      try {
        const [appMod, mod] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]);
        const app = appMod.initializeApp(authStatus.firebase);
        const auth = mod.initializeAuth(app, {
          persistence: [mod.indexedDBLocalPersistence, mod.browserLocalPersistence],
          popupRedirectResolver: mod.browserPopupRedirectResolver,
        });
        auth.useDeviceLanguage();
        this.fb = { auth, mod };
        mod.getRedirectResult(auth).catch((err) => this.emit('error', friendlyAuthError(err)));
        await new Promise((resolve) => {
          mod.onAuthStateChanged(auth, (user) => {
            this.#fromUser(user);
            resolve();
          });
        });
      } catch (err) {
        console.error('[Drone Hive AI] Sign-in failed to load', err);
        this.#set('error');
      }
    })();
    return this.initializing;
  }

  #fromUser(user) {
    this.user = user
      ? { uid: user.uid, email: user.email, name: user.displayName || '', verified: user.emailVerified, provider: user.providerData?.[0]?.providerId || 'password' }
      : null;
    this.#set(!user ? 'signed-out' : user.emailVerified ? 'signed-in' : 'unverified');
  }

  #set(state) {
    this.state = state;
    this.emit('change', { state, user: this.user });
  }

  // ── actions (each throws an Error with a friendly message) ──
  async #run(fn) {
    if (!this.fb) throw new Error('Sign-in is still loading. Try again in a second.');
    try {
      return await fn(this.fb.auth, this.fb.mod);
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
  }

  signInWithGoogle() {
    return this.#run(async (auth, m) => {
      const provider = new m.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await m.signInWithPopup(auth, provider);
      } catch (err) {
        // Popups blocked (some phones/in-app browsers): use a full-page redirect instead.
        if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/operation-not-supported-in-this-environment') {
          await m.signInWithRedirect(auth, provider);
          return;
        }
        throw err;
      }
    });
  }

  signIn(email, password) {
    return this.#run((auth, m) => m.signInWithEmailAndPassword(auth, email.trim(), password));
  }

  signUp(email, password, name) {
    return this.#run(async (auth, m) => {
      const cred = await m.createUserWithEmailAndPassword(auth, email.trim(), password);
      if (name?.trim()) await m.updateProfile(cred.user, { displayName: name.trim().slice(0, 40) }).catch(() => {});
      await m.sendEmailVerification(cred.user);
      this.#fromUser(auth.currentUser);
    });
  }

  resetPassword(email) {
    return this.#run((auth, m) => m.sendPasswordResetEmail(auth, email.trim()));
  }

  resendVerification() {
    return this.#run((auth, m) => m.sendEmailVerification(auth.currentUser));
  }

  /** Re-checks whether the user clicked the verification link. */
  checkVerified() {
    return this.#run(async (auth, m) => {
      if (!auth.currentUser) return false;
      await auth.currentUser.reload();
      // Get a fresh token so it carries email_verified: true.
      await m.getIdToken(auth.currentUser, true);
      this.#fromUser(auth.currentUser);
      return auth.currentUser.emailVerified;
    });
  }

  signOut() {
    return this.#run((auth, m) => m.signOut(auth));
  }

  /** Current ID token for /api/chat (refreshed by Firebase when needed). */
  async getToken(forceRefresh = false) {
    const user = this.fb?.auth.currentUser;
    if (!user) return null;
    return this.fb.mod.getIdToken(user, forceRefresh);
  }
}

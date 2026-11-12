/**
 * Keeps the app exactly the size of the visible screen on phones.
 *
 * When the on-screen keyboard opens, mobile browsers shrink the *visual*
 * viewport but often not the layout, so fixed-height apps end up with the
 * message box hidden behind the keyboard (iOS Safari especially). We size the
 * app to window.visualViewport and pin it to its top, so the composer always
 * sits right above the keyboard. Sets:
 *   --app-height   visible height in px
 *   --app-top      visual viewport offset (iOS scrolls the page when typing)
 *   .keyboard-open on <html> while the keyboard is up
 */
export function initViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  let fullHeight = window.innerHeight;
  let frame = 0;

  const update = () => {
    frame = 0;
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? Math.max(0, vv.offsetTop) : 0;
    if (!root.classList.contains('keyboard-open')) fullHeight = Math.max(fullHeight, window.innerHeight);
    root.style.setProperty('--app-height', `${Math.round(h)}px`);
    root.style.setProperty('--app-top', `${Math.round(top)}px`);
    const editing = document.activeElement?.matches?.('textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]), [contenteditable]');
    root.classList.toggle('keyboard-open', Boolean(editing) && h < fullHeight * 0.8);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };

  update();
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  window.addEventListener('resize', () => {
    fullHeight = window.innerHeight;
    schedule();
  });
  window.addEventListener('orientationchange', () => setTimeout(() => ((fullHeight = window.innerHeight), update()), 250));
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', () => setTimeout(update, 60));

  // iOS sometimes scrolls the whole (non-scrollable) page when the keyboard
  // opens; snap it back so the header doesn't slide off screen.
  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0 && !vv) window.scrollTo(0, 0);
  });
}

/* A brief, optional entrance. Content is visible by default if this enhancement fails. */
(() => {
  'use strict';
  const root = document.documentElement;
  let timer;
  let motion;
  const listeners = [];
  function finish() {
    delete root.dataset.museumEntry;
    window.clearTimeout(timer);
    listeners.splice(0).forEach(([target, type, handler]) => target.removeEventListener(type, handler));
  }
  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler]);
  }
  try {
    motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const query = new URLSearchParams(window.location.search);
    const navigation = window.performance?.getEntriesByType?.('navigation')[0];
    const previous = document.referrer ? new URL(document.referrer) : null;
    if (motion.matches || document.hidden || window.location.hash
      || ['q', 'attribute', 'publisher', 'images'].some(key => query.has(key))
      || (previous?.origin === window.location.origin && previous?.pathname === '/source.html')
      || navigation?.type === 'back_forward' || window.scrollY > 10) return;

    // Set before the body is parsed so there is no visible-then-hidden flash.
    root.dataset.museumEntry = 'opening';
    timer = window.setTimeout(finish, 2300);
    for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
      listen(window, type, finish, { passive: true });
    }
    listen(window, 'scroll', () => { if (window.scrollY > 10) finish(); }, { passive: true });
    listen(document, 'focusin', finish);
    listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
    listen(window, 'pagehide', finish);
    listen(window, 'pageshow', event => { if (event.persisted) finish(); });
    listen(document, 'animationend', event => {
      if (event.animationName === 'museum-scenery-arrive'
        && event.target?.matches?.('.museum-backdrop-frame')) finish();
    });
    if (typeof motion.addEventListener === 'function') {
      listen(motion, 'change', event => { if (event.matches) finish(); });
    }
  } catch (_) {
    finish();
  }
})();

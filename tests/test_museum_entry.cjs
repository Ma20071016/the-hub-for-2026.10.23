/* Optional museum entrance lifecycle, using an isolated head-script VM.
 * Run: node tests/test_museum_entry.cjs
 * No network, storage, real timers, or production data are involved.
 * Visual timing, contrast, and layout are verified separately in a browser.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../frontend/museum-entry.js'), 'utf8');

function entry(options = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const root = { dataset: { existing: 'preserve' } };
  const hubs = [];
  function hub(name) {
    const listeners = new Map();
    const target = {
      addEventListener(type, handler, settings = {}) {
        if (options.failListener === `${name}:${type}`) throw new Error('Listener unavailable');
        const capture = typeof settings === 'boolean' ? settings : Boolean(settings.capture);
        const list = listeners.get(type) || [];
        if (!list.some(item => item.handler === handler && item.capture === capture)) {
          list.push({ handler, capture, once: Boolean(settings.once) });
        }
        listeners.set(type, list);
      },
      removeEventListener(type, handler, settings = {}) {
        const capture = typeof settings === 'boolean' ? settings : Boolean(settings.capture);
        listeners.set(type, (listeners.get(type) || []).filter(item => item.handler !== handler || item.capture !== capture));
      },
      dispatch(type, detail = {}) {
        const event = {
          type, target, defaultPrevented: false, propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.propagationStopped = true; },
          ...detail,
        };
        for (const item of [...(listeners.get(type) || [])]) {
          if (!(listeners.get(type) || []).includes(item)) continue;
          if (item.once) target.removeEventListener(type, item.handler, item.capture);
          item.handler(event);
        }
        return event;
      },
      count() { return [...listeners.values()].reduce((sum, list) => sum + list.length, 0); },
    };
    hubs.push(target);
    return target;
  }
  const motion = Object.assign(hub('motion'), { matches: Boolean(options.reduced) });
  if (options.legacyMotion) motion.addEventListener = undefined;
  const document = Object.assign(hub('document'), { documentElement: root, hidden: Boolean(options.hidden), referrer: options.referrer || '' });
  const location = new URL(options.url || '/library.html', 'https://museum.example.invalid');
  const window = Object.assign(hub('window'), {
    location, scrollY: options.scrollY || 0,
    matchMedia(query) {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      if (options.matchMediaThrows) throw new Error('Motion preference unavailable');
      return motion;
    },
    performance: { getEntriesByType(type) {
      assert.equal(type, 'navigation');
      if (options.navigation === 'throw') throw new Error('Navigation timing unavailable');
      return options.navigation === 'empty' ? [] : [{ type: options.navigation || 'navigate' }];
    } },
    setTimeout(handler, delay) {
      if (options.timerThrows) throw new Error('Timer unavailable');
      const id = ++nextTimer; timers.set(id, { handler, delay }); return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  if (options.matchMediaMissing) window.matchMedia = undefined;
  if (options.navigation === 'missing-performance') delete window.performance;
  if (options.navigation === 'missing-method') delete window.performance.getEntriesByType;
  const context = vm.createContext({ window, document, URL, URLSearchParams });
  let baseline = 0;
  return {
    root, window, document, motion, timers,
    start() {
      baseline = hubs.reduce((sum, target) => sum + target.count(), 0);
      assert.doesNotThrow(() => vm.runInContext(script, context, { filename: 'museum-entry.js', timeout: 1000 }));
      return this;
    },
    opening() { assert.equal(root.dataset.museumEntry, 'opening'); },
    clean() {
      assert.deepEqual(root.dataset, { existing: 'preserve' });
      assert.equal(timers.size, 0, 'Completion must cancel its fallback timer.');
      assert.equal(hubs.reduce((sum, target) => sum + target.count(), 0), baseline, 'Completion must remove only its own listeners.');
    },
    expire() {
      for (const [id, timer] of [...timers]) { timers.delete(id); timer.handler(); }
    },
  };
}

const scenery = { matches: selector => selector === '.museum-backdrop-frame' };
const finishAnimation = page => page.document.dispatch('animationend', { animationName: 'museum-scenery-arrive', target: scenery });
let passed = 0;
function test(name, run) {
  run(); passed++; console.log(`ok ${passed} - ${name}`);
}

test('normal head execution starts once without waiting for body or data', () => {
  const page = entry().start();
  page.opening();
  assert.deepEqual([...page.timers.values()].map(timer => timer.delay), [2300]);
  assert.equal(page.root.dataset.existing, 'preserve');
  assert.equal(page.document.body, undefined);
  page.expire(); page.clean();
});

test('the scenery completion clears enhancement state and preserves other listeners', () => {
  const page = entry();
  let otherAnimation = 0; let otherHide = 0; let otherMotion = 0;
  page.document.addEventListener('animationend', () => { otherAnimation++; });
  page.window.addEventListener('pagehide', () => { otherHide++; });
  page.motion.addEventListener('change', () => { otherMotion++; });
  page.start(); finishAnimation(page); page.clean();
  page.document.dispatch('animationend'); page.window.dispatch('pagehide'); page.motion.dispatch('change', { matches: true });
  assert.equal(otherAnimation, 2); assert.equal(otherHide, 1); assert.equal(otherMotion, 1);
  page.clean();
});

test('child, unrelated, missing-target, and same-name foreign animations cannot finish early', () => {
  const page = entry().start();
  for (const detail of [
    { animationName: 'museum-title-arrive', target: scenery },
    { animationName: 'museum-scenery-arrive', target: { matches: () => false } },
    { animationName: 'museum-scenery-arrive', target: {} },
    { animationName: 'museum-scenery-arrive', target: null },
  ]) { page.document.dispatch('animationend', detail); page.opening(); }
  finishAnimation(page); page.clean();
});

test('the timeout restores a missing-animation page and repeated completion is harmless', () => {
  const page = entry().start();
  const queuedFinish = [...page.timers.values()][0].handler;
  page.expire(); page.clean();
  queuedFinish(); finishAnimation(page); page.window.dispatch('pagehide');
  page.window.dispatch('pageshow', { persisted: true });
  page.clean();
});

test('pointer, touch, wheel, and keyboard interaction finish without consuming input', () => {
  for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
    const page = entry().start();
    const event = page.window.dispatch(type, { key: 'Tab' });
    assert.equal(event.defaultPrevented, false); assert.equal(event.propagationStopped, false);
    page.clean();
  }
});

test('moving keyboard focus reveals content without cancelling focus', () => {
  const page = entry().start();
  const event = page.document.dispatch('focusin');
  assert.equal(event.defaultPrevented, false); assert.equal(event.propagationStopped, false);
  page.clean();
});

test('scroll restoration skips entry and user scrolling ends a running entry', () => {
  entry({ scrollY: 11 }).start().clean();
  const page = entry({ scrollY: 10 }).start(); page.opening();
  page.window.dispatch('scroll'); page.opening();
  page.window.scrollY = 11;
  const event = page.window.dispatch('scroll');
  assert.equal(event.defaultPrevented, false); page.clean();
});

test('reduced-motion preferences skip entry and finish immediately when changed', () => {
  entry({ reduced: true }).start().clean();
  const page = entry().start();
  page.motion.dispatch('change', { matches: false }); page.opening();
  page.motion.matches = true; page.motion.dispatch('change', { matches: true }); page.clean();
  page.motion.dispatch('change', { matches: false }); page.clean();
});

test('anchors and each catalog filter preserve direct navigation without animation', () => {
  for (const suffix of ['#catalog-title', '#library-title', '?q=', '?q=%E8%A1%A3%E5%86%A0', '?attribute=', '?publisher=example', '?images=0', '?q=a&images=1']) {
    const page = entry({ url: '/library.html' + suffix }).start();
    page.clean(); assert.equal(page.window.location.pathname + page.window.location.search + page.window.location.hash, '/library.html' + suffix);
  }
});

test('ordinary visits, reloads, and unrelated query parameters allow a fresh entry', () => {
  for (const options of [{ navigation: 'navigate' }, { navigation: 'reload' }, { url: '/library.html?utm_source=demo' }]) {
    const page = entry(options).start(); page.opening(); page.expire(); page.clean();
  }
  entry({ navigation: 'back_forward' }).start().clean();
});

test('ordinary return links from same-origin source details skip the entry', () => {
  for (const suffix of ['', '?id=1', '?id=1&images=1#evidence-2']) {
    entry({ navigation: 'navigate', referrer: 'https://museum.example.invalid/source.html' + suffix }).start().clean();
  }
});

test('external source paths and other local pages do not suppress a fresh visit', () => {
  for (const referrer of [
    'https://external.example.invalid/source.html?id=1',
    'http://museum.example.invalid/source.html?id=1',
    'https://museum.example.invalid:444/source.html?id=1',
    'https://museum.example.invalid/index.html',
    'https://museum.example.invalid/source.html/extra',
    '',
  ]) {
    const page = entry({ referrer }).start(); page.opening(); page.expire(); page.clean();
  }
  entry({ referrer: 'invalid referrer' }).start().clean();
});

test('missing navigation timing is optional and a timing failure degrades to static', () => {
  for (const navigation of ['empty', 'missing-performance', 'missing-method']) {
    const page = entry({ navigation }).start(); page.opening(); page.expire(); page.clean();
  }
  entry({ navigation: 'throw' }).start().clean();
});

test('background pages skip entry and hiding a visible page completes it', () => {
  entry({ hidden: true }).start().clean();
  const page = entry().start();
  page.document.dispatch('visibilitychange'); page.opening();
  page.document.hidden = true; page.document.dispatch('visibilitychange'); page.clean();
  page.document.hidden = false; page.document.dispatch('visibilitychange'); page.clean();
});

test('pagehide and persisted pageshow finish without replaying the entry', () => {
  const page = entry().start();
  page.window.dispatch('pageshow', { persisted: false }); page.opening();
  page.window.dispatch('pagehide'); page.clean();
  page.window.dispatch('pageshow', { persisted: true }); page.clean();
  const restored = entry().start();
  restored.window.dispatch('pageshow', { persisted: true }); restored.clean();
  restored.window.dispatch('pageshow', { persisted: false }); restored.clean();
});

test('missing or throwing motion detection leaves the static page available', () => {
  for (const options of [{ matchMediaMissing: true }, { matchMediaThrows: true }]) entry(options).start().clean();
});

test('partial initialization failure restores content and cleans registered resources', () => {
  for (const options of [
    { timerThrows: true },
    { failListener: 'window:pointerdown' },
    { failListener: 'document:focusin' },
    { failListener: 'motion:change' },
  ]) entry(options).start().clean();
});

test('legacy media-query objects retain the timeout fallback without change events', () => {
  const page = entry({ legacyMotion: true }).start();
  page.opening(); page.expire(); page.clean();
  entry({ legacyMotion: true, reduced: true }).start().clean();
});

console.log(`Museum entry: ${passed} scenarios passed.`);

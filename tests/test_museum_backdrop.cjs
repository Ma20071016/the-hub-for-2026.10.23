/* Museum orbit geometry and lifecycle checks, independent from the exhibit carousel.
 * Run: node tests/test_museum_backdrop.cjs
 * Production JavaScript runs in an isolated VM with virtual images, timers and visibility.
 * No network, storage, browser profile or production database is used.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../frontend/museum-backdrop.js'), 'utf8');
const fixture = () => [7, 3, 1, 4, 2].map(id => ({
  id, title: `资料 ${id}`, object_names: [`测试服饰 ${id}`],
  cover: { url: `/img/library/fixture-${id}.jpg`, width: id === 2 ? 1600 : 900, height: id === 2 ? 350 : 1200, alt: `测试配图 ${id}` },
}));

function page(options = {}) {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, handler, settings = {}) {
      const list = this.listeners.get(type) || [];
      list.push({ handler, once: Boolean(settings?.once) });
      this.listeners.set(type, list);
    }
    removeEventListener(type, handler) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.handler !== handler));
    }
    dispatch(type, detail = {}) {
      const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...detail };
      for (const item of [...(this.listeners.get(type) || [])]) {
        if (item.once) this.removeEventListener(type, item.handler);
        item.handler(event);
      }
      return event;
    }
  }
  class Element extends Target {
    constructor(tag = 'div') {
      super(); this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {};
      this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] || ''; } };
      this.className = ''; this.hidden = false; this.disabled = false; this.parentElement = null; this._text = '';
    }
    get classList() {
      const values = () => new Set(this.className.split(/\s+/).filter(Boolean));
      return {
        add: name => { const list = values(); list.add(name); this.className = [...list].join(' '); },
        remove: name => { const list = values(); list.delete(name); this.className = [...list].join(' '); },
        contains: name => values().has(name),
      };
    }
    append(...nodes) { nodes.forEach(node => { node.remove(); node.parentElement = this; this.children.push(node); }); }
    replaceChildren(...nodes) { [...this.children].forEach(node => node.remove()); this._text = ''; this.append(...nodes); }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
      this.parentElement = null;
    }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    click() { if (!this.disabled) return this.dispatch('click'); }
  }
  const ids = new Map();
  for (const id of ['stage', 'controls', 'toggle', 'previous', 'next', 'title', 'position', 'link']) {
    const node = new Element(['toggle', 'previous', 'next'].includes(id) ? 'button' : id === 'link' ? 'a' : 'div');
    node.id = 'museum-backdrop-' + id; ids.set(node.id, node);
  }
  const hero = new Element('section'); hero.id = 'museum-intro'; ids.set(hero.id, hero);
  const get = id => ids.get('museum-backdrop-' + id);
  get('controls').append(get('previous'), get('toggle'), get('next'), get('position'));
  hero.append(get('stage'), get('title'), get('link'), get('controls'));
  get('controls').hidden = get('link').hidden = true;
  if (options.missing) ids.delete(options.missing);
  const document = Object.assign(new Target(), {
    hidden: Boolean(options.hidden), getElementById: id => ids.get(id), createElement: tag => new Element(tag),
  });
  const motion = Object.assign(new Target(), { matches: Boolean(options.reduced) });
  if (options.legacyMotion) motion.addEventListener = undefined;
  const timers = new Map(); const frames = new Map();
  let now = 0; let counter = 0; let observer;
  const window = Object.assign(new Target(), {
    setTimeout(callback, delay) { const id = ++counter; timers.set(id, { callback, delay, time: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++counter; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    performance: { now: () => now },
    matchMedia(query) { assert.equal(query, '(prefers-reduced-motion: reduce)'); return motion; },
    IntersectionObserver: class {
      constructor(callback, settings) { observer = { callback, settings, targets: [] }; }
      observe(target) { observer.targets.push(target); }
    },
  });
  if (options.noObserver) delete window.IntersectionObserver;
  if (options.noMotion) delete window.matchMedia;
  if (options.noFrames) delete window.requestAnimationFrame;
  if (options.noCancelFrames) delete window.cancelAnimationFrame;
  vm.runInNewContext(script, { document, window }, { filename: 'museum-backdrop.js', timeout: 1000 });
  const instance = window.MuseumBackdrop.create();
  const result = {
    instance, get, document, window, motion, timers, frames,
    setSources(values = fixture()) { instance.setSources(values); return result; },
    images() { return get('stage').querySelectorAll('img'); },
    cards() { return get('stage').children.filter(card => card.classList.contains('museum-orbit-card')); },
    readyCards() { return result.cards().filter(card => card.classList.contains('is-ready')); },
    card(id) { return result.cards().find(card => Number(card.dataset.sourceId) === id); },
    image(id) { return result.card(id)?.querySelectorAll('img')[0]; },
    front() { return result.readyCards().find(card => card.dataset.front === 'true'); },
    rotation() { return Number(get('stage').dataset.rotation); },
    shown() { return get('title').textContent; },
    sourceId() { return Number(new URL(get('link').href, 'https://museum.example.invalid').searchParams.get('id')); },
    load(image) { assert.ok(image, 'Expected an image.'); image.dispatch('load'); return image; },
    fail(image) { assert.ok(image, 'Expected an image.'); image.dispatch('error'); return image; },
    loadAll() { result.images().forEach(image => result.load(image)); return result; },
    visible(value = true) {
      assert.ok(observer, 'Expected an IntersectionObserver.');
      assert.deepEqual(observer.targets, [hero]);
      assert.equal(observer.settings.threshold, 0.15);
      observer.callback([{ target: hero, isIntersecting: value }]);
    },
    tick(duration) {
      const until = now + duration; let handled = 0;
      while (true) {
        const next = [...timers].filter(([, task]) => task.time <= until).sort((a, b) => a[1].time - b[1].time)[0];
        if (!next) break;
        assert.ok(++handled < 100, 'Virtual timer loop must remain bounded.');
        const [id, task] = next; timers.delete(id); now = task.time; task.callback();
      }
      now = until;
    },
    frame(duration = 16) {
      result.tick(duration);
      for (const [id, callback] of [...frames]) {
        if (!frames.has(id)) continue;
        frames.delete(id); callback(now);
      }
    },
    advance(duration) {
      let remaining = duration;
      while (remaining > 0) { const step = Math.min(16, remaining); result.frame(step); remaining -= step; }
    },
    timerCount(delay) { return [...timers.values()].filter(task => task.delay === delay).length; },
    playing(value, moving = value) {
      assert.equal(get('stage').dataset.playing, String(value));
      assert.equal(get('stage').dataset.moving, String(moving));
      assert.equal(frames.size, moving ? 1 : 0, 'At most one animation frame may be queued.');
    },
  };
  return result;
}

let passed = 0;
function test(name, run) { run(); passed++; console.log(`ok ${passed} - ${name}`); }
function near(actual, expected, tolerance = 0.001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}.`);
}
function property(card, name) { return parseFloat(card.style.getPropertyValue(name)); }
function ready(options = {}, values = fixture()) {
  const state = page(options).setSources(values).loadAll();
  if (!options.noObserver) state.visible();
  return state;
}
function verifyFront(state, id) {
  assert.equal(state.sourceId(), id);
  assert.equal(Number(state.front().dataset.sourceId), id);
  assert.equal(state.shown(), `测试服饰 ${id}`);
}

test('missing markup and empty collections leave the optional stage inactive', () => {
  for (const missing of ['museum-intro', 'museum-backdrop-stage', 'museum-backdrop-controls', 'museum-backdrop-link']) {
    const state = page({ missing }); assert.equal(state.instance, null);
    assert.equal(state.timers.size, 0); assert.equal(state.frames.size, 0);
  }
  for (const values of [[], fixture().filter(source => source.id === 3), fixture().map(source => ({ ...source, cover: null }))]) {
    const state = page().setSources(values);
    assert.equal(state.cards().length, 0); assert.equal(state.timers.size, 0); state.playing(false);
    assert.equal(state.get('controls').hidden, true); assert.equal(state.get('link').hidden, true);
    assert.equal(state.get('position').textContent, '');
  }
});

test('eligible images load together in stable order with independent deadlines', () => {
  const values = fixture(); values.push({ ...values.find(source => source.id === 1) });
  const before = JSON.stringify(values); const state = page().setSources(values);
  assert.equal(JSON.stringify(values), before);
  assert.deepEqual(state.cards().map(card => Number(card.dataset.sourceId)), [1, 2, 4, 7]);
  assert.deepEqual(state.images().map(image => image.src), [1, 2, 4, 7].map(id => `/img/library/fixture-${id}.jpg`));
  assert.equal(state.timerCount(12000), 4); state.playing(false);
  assert.equal(state.get('link').hidden, true);
  for (const id of [7, 2, 1, 4]) {
    const image = state.image(id); const source = values.find(item => item.id === id);
    assert.equal(image.alt, ''); assert.equal(image.width, source.cover.width); assert.equal(image.height, source.cover.height);
    state.load(image);
  }
  assert.equal(state.readyCards().length, 4); assert.equal(state.images().length, 4);
  assert.equal(state.timerCount(12000), 0);
  assert.deepEqual(state.readyCards().map(card => Number(card.dataset.sourceId)), [1, 2, 4, 7]);
  verifyFront(state, 7); assert.equal(state.get('position').textContent, '04 / 04');
});

test('front, side and rear panels have consistent non-mirrored three-dimensional geometry', () => {
  const state = ready({ reduced: true }); state.playing(false);
  for (const [id, x, z, yaw, shade] of [
    [1, 0, 1, 0, 0], [2, 1, 0, 62, 0.27],
    [4, 0, -1, 0, 0.54], [7, -1, 0, -62, 0.27],
  ]) {
    const card = state.card(id);
    near(property(card, '--orbit-x'), x); near(property(card, '--orbit-z'), z);
    near(property(card, '--orbit-yaw'), yaw);
    assert.ok(card.style.opacity === undefined || card.style.opacity === '' || Number(card.style.opacity) === 1, 'Panels stay opaque to occlude photographs behind them.');
    near(property(card, '--orbit-shade'), shade);
    assert.ok(Math.abs(property(card, '--orbit-yaw')) < 90, 'A photograph must not turn its mirrored rear face toward the viewer.');
  }
  verifyFront(state, 1); assert.equal(state.get('position').textContent, '01 / 04');
  state.get('next').click(); state.playing(false); verifyFront(state, 2);
  near(property(state.card(2), '--orbit-x'), 0); near(property(state.card(2), '--orbit-z'), 1);
  near(property(state.card(2), '--orbit-yaw'), 0); near(property(state.card(2), '--orbit-shade'), 0);
  assert.equal(state.images().length, 4);
});

test('continuous rotation takes seventy-two seconds per turn without replacing images', () => {
  const state = ready(); const images = state.images(); state.playing(true);
  state.frame(0); state.advance(1000); near(state.rotation(), -5);
  state.advance(17000); near(state.rotation(), -90); verifyFront(state, 2);
  state.advance(18000); near(state.rotation(), -180); verifyFront(state, 4);
  state.advance(18000); near(state.rotation(), -270); verifyFront(state, 7);
  state.advance(18000); const remainder = Math.abs(state.rotation()) % 360;
  near(Math.min(remainder, 360 - remainder), 0); verifyFront(state, 1);
  assert.deepEqual(state.images(), images); assert.equal(state.timers.size, 0); state.playing(true);
});

test('large or backwards animation timestamps cannot jump or reverse the orbit', () => {
  const state = ready(); state.frame(0); state.frame(100000);
  near(state.rotation(), -0.32);
  const angle = state.rotation(); const callback = [...state.frames.values()][0];
  state.frames.clear(); callback(99999); near(state.rotation(), angle); state.playing(true);
});

test('manual next and previous ease to complete front views and remain paused', () => {
  const state = ready(); const images = state.images();
  state.get('next').click(); state.playing(false, true); near(state.rotation(), 0);
  state.frame(0); state.advance(600);
  assert.ok(state.rotation() < -45 && state.rotation() > -90);
  state.advance(600); near(state.rotation(), -90); verifyFront(state, 2); state.playing(false);
  assert.equal(state.get('toggle').textContent, '继续旋转');
  assert.equal(state.get('toggle').getAttribute('aria-pressed'), 'true');
  state.get('previous').click(); state.frame(0); state.advance(1200);
  near(state.rotation(), 0); verifyFront(state, 1); state.playing(false);
  state.get('previous').click(); state.frame(0); state.advance(1200);
  near(state.rotation(), 90); verifyFront(state, 7); state.playing(false);
  assert.deepEqual(state.images(), images); assert.equal(state.timers.size, 0);
});

test('a new manual selection continues from the displayed angle and supersedes the old target', () => {
  const state = ready(); state.get('next').click(); state.frame(0); state.advance(400);
  const angle = state.rotation(); state.get('previous').click(); near(state.rotation(), angle);
  state.advance(1200); near(state.rotation(), 0); verifyFront(state, 1); state.playing(false);
  state.get('next').click(); state.get('next').click(); state.frame(0); state.advance(1200);
  near(state.rotation(), -180); verifyFront(state, 4); state.playing(false);
});

test('reduced motion is static and manual selection aligns immediately', () => {
  const state = ready({ reduced: true }); state.playing(false);
  assert.equal(state.get('toggle').disabled, true); assert.equal(state.get('toggle').textContent, '静态浏览');
  state.get('next').click(); near(state.rotation(), -90); verifyFront(state, 2); state.playing(false);
  state.get('previous').click(); near(state.rotation(), 0); verifyFront(state, 1); state.playing(false);
  state.get('previous').click(); near(state.rotation(), 90); verifyFront(state, 7); state.playing(false);
});

test('motion changes stop animation, finish a requested alignment, and retain user pause', () => {
  const state = ready(); state.frame(0); state.advance(1000);
  state.motion.matches = true; state.motion.dispatch('change'); state.playing(false); near(state.rotation(), 0);
  state.motion.matches = false; state.motion.dispatch('change'); state.playing(true);
  state.get('next').click(); state.frame(0); state.advance(400);
  state.motion.matches = true; state.motion.dispatch('change');
  near(state.rotation(), -90); verifyFront(state, 2); state.playing(false);
  state.motion.matches = false; state.motion.dispatch('change'); state.playing(false);
});

test('offscreen and hidden states freeze the phase and resume without a time jump', () => {
  const state = ready(); state.frame(0); state.advance(3000); const angle = state.rotation();
  state.visible(false); state.playing(false); state.advance(100000); near(state.rotation(), angle);
  state.document.hidden = true; state.document.dispatch('visibilitychange'); state.visible(); state.playing(false);
  state.document.hidden = false; state.document.dispatch('visibilitychange'); state.playing(true);
  state.frame(16); near(state.rotation(), angle); state.advance(1000); near(state.rotation(), angle - 5);
  state.visible(); state.document.dispatch('visibilitychange'); state.playing(true);
  state.get('toggle').click(); state.visible(false); state.visible();
  state.document.hidden = true; state.document.dispatch('visibilitychange');
  state.document.hidden = false; state.document.dispatch('visibilitychange'); state.playing(false);
});

test('keyboard focus pauses automatic rotation until leaving or explicitly continuing', () => {
  const state = ready(); state.get('controls').dispatch('focusin'); state.playing(false);
  state.get('controls').dispatch('focusout', { relatedTarget: state.get('next') }); state.playing(false);
  state.get('controls').dispatch('focusout', { relatedTarget: null }); state.playing(true);
  state.get('controls').dispatch('focusin'); state.get('toggle').click(); state.playing(false);
  state.get('toggle').click(); state.playing(true);
  state.frame(0); state.advance(1000); near(state.rotation(), -5);
  state.get('controls').dispatch('focusin'); state.playing(false);
});

test('manual alignment pauses outside the view and resumes its remaining duration', () => {
  const state = ready(); state.get('next').click(); state.frame(0); state.advance(400);
  const angle = state.rotation(); state.visible(false); state.playing(false); state.advance(5000);
  near(state.rotation(), angle); state.visible(); state.playing(false, true);
  state.frame(16); near(state.rotation(), angle);
  state.advance(400); assert.ok(state.rotation() < angle && state.rotation() > -90);
  state.advance(400); near(state.rotation(), -90); verifyFront(state, 2); state.playing(false);
});

test('cancelled animation callbacks cannot mutate or reschedule a paused or replaced stage', () => {
  const state = ready(); state.frame(0); const stale = [...state.frames.values()][0]; const angle = state.rotation();
  state.visible(false); stale(1000); near(state.rotation(), angle); state.playing(false);
  state.visible(); const previousBatch = [...state.frames.values()][0];
  state.setSources().loadAll(); const currentCards = state.cards(); const currentAngle = state.rotation();
  previousBatch(100000); near(state.rotation(), currentAngle); assert.deepEqual(state.cards(), currentCards); state.playing(true);
});

test('missing animation or visibility capabilities allow static manual browsing', () => {
  for (const options of [{ noFrames: true }, { noCancelFrames: true }, { noObserver: true }, { noMotion: true }, { legacyMotion: true, reduced: true }]) {
    const state = ready(options); state.playing(false);
    state.get('next').click(); verifyFront(state, 2); near(state.rotation(), -90); state.playing(false);
  }
});

test('partially failed images reflow only available exhibits and preserve the current front', () => {
  const state = page().setSources(); state.load(state.image(1)); state.load(state.image(4));
  verifyFront(state, 1); assert.equal(state.get('position').textContent, '01 / 02');
  near(property(state.card(4), '--orbit-z'), -1);
  state.fail(state.image(2)); state.tick(12000);
  assert.deepEqual(state.cards().map(card => Number(card.dataset.sourceId)), [1, 4]);
  assert.equal(state.timers.size, 0); verifyFront(state, 1);
  state.load(state.image(4)); state.fail(state.image(1));
  assert.equal(state.readyCards().length, 2, 'A late error after successful loading cannot remove a ready image.');
  const three = page().setSources(); three.load(three.image(1)); three.load(three.image(2)); three.load(three.image(4)); three.fail(three.image(7));
  assert.equal(three.get('position').textContent, '01 / 03');
  near(property(three.card(2), '--orbit-x'), Math.sqrt(3) / 2);
  near(property(three.card(2), '--orbit-z'), -0.5);
});

test('single and fully unavailable collections stop all animation and expose truthful controls', () => {
  const single = ready({}, fixture().filter(source => source.id === 4));
  verifyFront(single, 4); single.playing(false);
  for (const id of ['previous', 'next', 'toggle']) assert.equal(single.get(id).disabled, true);
  assert.equal(single.get('position').textContent, '01 / 01');
  const state = page().setSources(); const images = state.images(); state.tick(12000);
  assert.equal(state.cards().length, 0); assert.equal(state.timers.size, 0); state.playing(false);
  assert.equal(state.get('controls').hidden, true); assert.equal(state.get('link').hidden, true);
  assert.match(state.shown(), /暂不可用/);
  images.forEach(image => { image.dispatch('load'); image.dispatch('error'); });
  assert.equal(state.cards().length, 0); assert.equal(state.timers.size, 0); state.playing(false);
});

test('clearing or replacing a batch invalidates its images and preserves manual pause', () => {
  const state = page().setSources(); const images = state.images(); const timers = [...state.timers.values()];
  state.instance.clear(); assert.equal(state.cards().length, 0); assert.equal(state.timers.size, 0); state.playing(false);
  state.setSources().loadAll(); state.visible(); const cards = state.cards();
  images.forEach(image => { image.dispatch('load'); image.dispatch('error'); }); timers.forEach(timer => timer.callback());
  assert.deepEqual(state.cards(), cards); verifyFront(state, 1); state.playing(true);
  state.get('toggle').click(); state.setSources().loadAll(); state.playing(false);
  state.get('toggle').click(); state.playing(true);
});

test('cached return retains loaded exhibits and resumes a single frame without losing user pause', () => {
  const state = ready(); const images = state.images(); state.frame(0); state.advance(1000); const angle = state.rotation();
  state.window.dispatch('pageshow', { persisted: false }); assert.deepEqual(state.images(), images); state.playing(true);
  state.window.dispatch('pagehide', { persisted: true }); state.playing(false); assert.equal(state.timers.size, 0);
  state.advance(100000); state.window.dispatch('pageshow', { persisted: true });
  assert.deepEqual(state.images(), images); state.playing(true); state.frame(16); near(state.rotation(), angle);
  state.advance(1000); near(state.rotation(), angle - 5);
  state.get('toggle').click(); state.window.dispatch('pagehide'); state.window.dispatch('pageshow', { persisted: true }); state.playing(false);
});

test('cached return retries only interrupted images and rejects their old events', () => {
  const state = page().setSources(); state.visible(); const first = state.image(1); state.load(first);
  const interrupted = [2, 4, 7].map(id => state.image(id));
  state.window.dispatch('pageshow', { persisted: false }); assert.deepEqual([2, 4, 7].map(id => state.image(id)), interrupted);
  state.window.dispatch('pagehide', { persisted: true }); assert.equal(state.timers.size, 0); state.playing(false);
  assert.deepEqual(state.images(), [first]);
  state.window.dispatch('pageshow', { persisted: true });
  assert.equal(state.image(1), first); assert.equal(state.timerCount(12000), 3);
  for (const [index, id] of [2, 4, 7].entries()) assert.notEqual(state.image(id), interrupted[index]);
  interrupted.forEach(image => { image.dispatch('load'); image.dispatch('error'); });
  assert.equal(state.readyCards().length, 1); assert.equal(state.timerCount(12000), 3);
  state.loadAll(); assert.equal(state.readyCards().length, 4); assert.equal(state.timers.size, 0); state.playing(true);
});

test('focusing the detail link freezes its destination throughout control focus transfers', () => {
  const state = ready(); state.frame(0); state.advance(1000);
  const angle = state.rotation(); const href = state.get('link').href;
  state.get('controls').dispatch('focusin'); state.playing(false);
  state.get('controls').dispatch('focusout', { relatedTarget: state.get('link') }); state.playing(false);
  state.get('link').dispatch('focus'); state.playing(false);
  state.advance(40000); near(state.rotation(), angle); assert.equal(state.get('link').href, href);
  state.get('link').dispatch('blur', { relatedTarget: state.get('next') }); state.playing(false);
  state.get('controls').dispatch('focusin'); state.playing(false);
  state.advance(1000); near(state.rotation(), angle); assert.equal(state.get('link').href, href);
  state.get('controls').dispatch('focusout', { relatedTarget: null }); state.playing(true);
  state.frame(16); near(state.rotation(), angle); state.advance(1000); near(state.rotation(), angle - 5);
});

test('detail-link focus pauses a manual alignment and blur resumes its remaining duration', () => {
  const state = ready(); state.get('next').click(); state.frame(0); state.advance(400);
  const angle = state.rotation(); const href = state.get('link').href;
  const cancelled = [...state.frames.values()][0];
  state.get('link').dispatch('focus'); state.playing(false);
  cancelled(5000); state.advance(40000);
  near(state.rotation(), angle); assert.equal(state.get('link').href, href); state.playing(false);
  state.get('link').dispatch('blur', { relatedTarget: null }); state.playing(false, true);
  state.frame(16); near(state.rotation(), angle);
  state.advance(400); assert.ok(state.rotation() < angle && state.rotation() > -90);
  state.advance(400); near(state.rotation(), -90); verifyFront(state, 2); state.playing(false);
  assert.equal(state.get('toggle').getAttribute('aria-pressed'), 'true');
});

test('clearing and reloading retain detail-link and control focus pause semantics', () => {
  const state = ready(); state.get('link').dispatch('focus'); state.playing(false);
  state.instance.clear(); state.setSources().loadAll(); state.playing(false);
  const angle = state.rotation(); state.advance(10000); near(state.rotation(), angle);
  state.get('link').dispatch('blur', { relatedTarget: null }); state.playing(true);
  state.get('controls').dispatch('focusin'); state.playing(false);
  state.instance.clear(); state.setSources().loadAll(); state.playing(false);
  state.get('controls').dispatch('focusout', { relatedTarget: null }); state.playing(true);
});

test('unsafe sources stay excluded and source labels remain literal text', () => {
  const values = fixture();
  values.find(source => source.id === 1).cover.url = 'javascript:alert(1)';
  values.find(source => source.id === 2).cover.url = 'https://example.invalid/photo.jpg';
  values.find(source => source.id === 4).cover.url = '/img/library/../photo.jpg';
  const safe = values.find(source => source.id === 7); safe.object_names = ['<img src=x onerror=alert(1)>'];
  const state = ready({}, values);
  assert.equal(state.sourceId(), 7); assert.equal(state.shown(), safe.object_names[0]); assert.equal(state.get('title').children.length, 0);
  safe.object_names = []; safe.title = '<script>alert(1)</script>';
  state.setSources([safe]).loadAll(); assert.equal(state.shown(), safe.title); assert.equal(state.get('title').children.length, 0);
});

console.log(`Museum orbit: ${passed} scenarios passed.`);

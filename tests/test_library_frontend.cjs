/* Dependency-free library/detail regression checks.
 * Run: node tests/test_library_frontend.cjs
 * Execute the real page scripts with API-shaped fixtures and observable DOM
 * events. Browser checks remain responsible for visual layout/accessibility.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { await flush(); await flush(); };
const descendants = (node, predicate) => node.children.flatMap(child => [
  ...(predicate(child) ? [child] : []), ...descendants(child, predicate),
]);

function page(name, address, payload, status = 200) {
  const ids = new Map();
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.dataset = {};
      this.style = { setProperty(name, value) { this[name] = String(value); }, getPropertyValue(name) { return this[name] || ''; } };
      this.attributes = {};
      this.events = {};
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.className = '';
      this._text = '';
      this._value = '';
    }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set value(value) {
      const text = String(value);
      this._value = this.tagName === 'select' && !this.children.some(child => child.value === text) ? '' : text;
    }
    get value() { return this._value; }
    get firstElementChild() { return this.children.find(child => child.tagName !== '#text'); }
    get classList() {
      const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
      return {
        add: name => { const values = tokens(); values.add(name); this.className = [...values].join(' '); },
        remove: name => { const values = tokens(); values.delete(name); this.className = [...values].join(' '); },
        contains: name => tokens().has(name),
      };
    }
    append(...children) { children.forEach(child => { child.parentElement = this; }); this.children.push(...children); }
    replaceChildren(...children) {
      this.children.forEach(child => { child.parentElement = null; });
      this._text = ''; this.children = []; this.append(...children);
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    querySelectorAll(tag) { return descendants(this, node => node.tagName === tag); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(type, callback) { this.events[type] = callback; }
    click() { if (!this.disabled) return this.events.click?.({}); }
    focus() { this.focused = true; }
    scrollIntoView() { this.scrolledIntoView = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.events.close?.({}); }
  }
  const html = fs.readFileSync(path.join(root, `frontend/${name}.html`), 'utf8');
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1]);
    node.id = match[2];
    node.hidden = /\bhidden\b/.test(match[0]);
    node.disabled = /\bdisabled\b/.test(match[0]);
  }
  const document = {
    title: '', hidden: false, events: {}, getElementById: id => ids.get(id),
    addEventListener(type, handler) { this.events[type] = handler; },
    createElement: tag => new Element(tag),
    createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
  };
  const location = {};
  const setAddress = value => {
    const url = new URL(value, 'http://localhost');
    for (const key of ['href', 'pathname', 'search', 'hash', 'origin']) location[key] = url[key];
  };
  setAddress(address);
  let responseData = clone(payload);
  let responseStatus = status;
  let hang = false;
  let nextTimer = 1;
  const timers = new Map();
  const windowEvents = new Map();
  const requests = [];
  const window = {
    location,
    history: { replaceState(state, title, value) { setAddress(value); } },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, callback) { windowEvents.set(type, callback); },
    matchMedia: () => ({ matches: true }),
  };
  const fetch = async (route, options) => {
    requests.push(route);
    if (hang) return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return { ok: responseStatus === 200, status: responseStatus, json: async () => clone(responseData) };
  };
  const context = vm.createContext({ document, window, fetch, URL, URLSearchParams, AbortController, console, Error, TypeError, SyntaxError });
  const start = () => {
    for (const script of html.matchAll(/<script src="\.\/([a-z-]+\.js)" defer><\/script>/g)) {
      // This harness owns public catalog/detail behavior and its API-shaped
      // responses. Account bootstrapping has a separate DOM/session harness in
      // test_account_frontend.cjs; do not feed catalog fixtures to that script.
      if (script[1] === 'account.js') continue;
      vm.runInContext(fs.readFileSync(path.join(root, 'frontend', script[1]), 'utf8'), context);
    }
  };
  const api = {
    ids, requests, location, document, window,
    get: id => ids.get(id),
    start,
    respond(data, nextStatus = 200) { responseData = clone(data); responseStatus = nextStatus; hang = false; },
    stall() { hang = true; },
    expireRequests() {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 15000) continue; // Backdrop images have their own independently tested timeout.
        timers.delete(id);
        timer.callback();
      }
    },
    edit(id, value, type = 'input') { const node = ids.get(id); node.value = value; node.events[type]({}); },
  };
  return api;
}

// Synthetic interface fixtures matching /api/library and /api/library/{id}.
// These do not add records to a database or represent model accuracy results.
const catalog = {
  stats: { available_sources: 13, approved_evidence: 14 },
  attributes: ['形制', '材质', '工艺'], publishers: ['示例馆一', '示例馆二'],
  sources: Array.from({ length: 13 }, (_, index) => ({
    id: index + 1, title: index === 0 ? '示例棉袍' : `服饰资料 ${index + 1}`,
    publisher: index === 0 ? '示例馆一' : '示例馆二',
    source_url: `https://example.invalid/source/${index + 1}`, retrieved_at: '2026-10-17',
    object_names: [index === 0 ? '棉袍' : '大袖衫'], aliases: index === 0 ? ['长袍'] : [],
    attributes: index === 0 ? ['形制', '材质'] : [index === 1 ? '工艺' : '形制'],
    keywords: index === 0 ? ['对襟', '棉布'] : ['大袖'],
    catalog_numbers: [`MFB${String(index + 1).padStart(3, '0')}`],
    excerpt: index === 0 ? '棉袍使用棉布。采用对襟设计。' : '大袖衫资料原文。',
    evidence_count: index === 0 ? 2 : 1,
  })),
};
const prefix = '🧵馆藏：\n';
const firstQuote = '棉袍使用棉布。';
const secondQuote = '采用对襟设计。';
const start = Array.from(prefix).length;
const secondStart = start + Array.from(firstQuote).length + 1;
const detail = {
  source: { id: 1, title: '示例棉袍', publisher: '示例馆一', source_url: 'https://example.invalid/source/1',
    retrieved_at: '2026-10-17', original_text: `${prefix}${firstQuote}\n${secondQuote}\n原文结尾。` },
  objects: [{ name: '棉袍', aliases: ['棉袍', '长袍'], attributes: ['材质', '形制'], evidence_ids: [11, 12] }],
  catalog_numbers: ['MFB001'], evidence_count: 2,
  evidence: [
    { id: 11, object_name: '棉袍', aliases: ['长袍'], attributes: ['材质'], keywords: ['棉布'], text: firstQuote,
      locator: `chars:${start}:${start + Array.from(firstQuote).length}`, locator_verified: true,
      start, end: start + Array.from(firstQuote).length },
    { id: 12, object_name: '棉袍', aliases: ['长袍'], attributes: ['形制'], keywords: ['对襟'], text: secondQuote,
      locator: `chars:${secondStart}:${secondStart + Array.from(secondQuote).length}`, locator_verified: true,
      start: secondStart, end: secondStart + Array.from(secondQuote).length },
  ],
};
const anchors = node => descendants(node, child => child.tagName === 'a');
const buttons = node => descendants(node, child => child.tagName === 'button');
const visibleIds = library => anchors(library.get('library-list')).map(link =>
  Number(new URL(link.href, 'http://localhost').searchParams.get('id')));

async function run() {
  // 1. Counts reflect the full catalog while the first page shows 12 items.
  const library = page('library', '/library.html', catalog);
  library.start(); await settle();
  assert.deepEqual(library.requests, ['/api/library']);
  assert.equal(library.get('source-total').textContent, '13');
  assert.equal(library.get('evidence-total').textContent, '14');
  assert.equal(library.get('library-list').children.length, 12);
  assert.equal(library.get('library-status').dataset.state, 'ready');
  assert.equal(library.get('library-more').hidden, false);
  library.get('library-more').click();
  assert.deepEqual(visibleIds(library), catalog.sources.map(source => source.id));
  assert.equal(library.get('library-more').hidden, true);

  // 2. Catalog IDs, multiword search and attribute/publisher filters compose.
  library.edit('library-search', 'mfb001');
  assert.deepEqual(visibleIds(library), [1]);
  library.edit('library-search', '长袍 对襟');
  assert.deepEqual(visibleIds(library), [1]);
  library.edit('library-search', '');
  library.edit('library-attribute', '材质', 'change');
  assert.deepEqual(visibleIds(library), [1]);
  library.edit('library-publisher', '示例馆二', 'change');
  assert.deepEqual(visibleIds(library), []);
  assert.equal(library.get('library-empty').hidden, false);
  library.edit('library-attribute', '', 'change');
  assert.deepEqual(visibleIds(library), Array.from({ length: 12 }, (_, index) => index + 2));
  library.edit('library-search', '长袍 对襟');
  library.edit('library-attribute', '材质', 'change');
  library.edit('library-publisher', '示例馆一', 'change');
  assert.deepEqual(visibleIds(library), [1]);

  // 3. Detail/back navigation retains the search; review uses the chosen ID.
  const detailHref = anchors(library.get('library-list'))[0].href;
  const detailURL = new URL(detailHref, 'http://localhost');
  const source = page('source', detailURL.href, detail);
  source.start(); await settle();
  assert.deepEqual(source.requests, ['/api/library/1']);
  assert.equal(source.get('source-content').hidden, false);
  assert.equal(source.get('source-title').textContent, detail.source.title);
  assert.equal(source.get('source-evidence-count').textContent, '2 条已审核');
  const backURL = new URL(source.get('source-back').href, 'http://localhost');
  for (const key of ['q', 'attribute', 'publisher']) {
    assert.equal(backURL.searchParams.get(key), detailURL.searchParams.get(key));
  }
  assert.equal(backURL.pathname, '/library.html');
  assert.equal(backURL.searchParams.has('id'), false);
  assert.equal(source.get('source-review').href, './index.html?source=1');

  // 4. Locators use Unicode code points and preserve every original character.
  assert.equal(source.get('source-original').textContent, detail.source.original_text);
  const locateButtons = buttons(source.get('source-evidence'));
  assert.equal(locateButtons.length, 2);
  for (const [index, button] of locateButtons.entries()) {
    button.click();
    assert.equal(source.get('source-active-evidence').textContent, detail.evidence[index].text);
    assert.equal(source.get('source-original').textContent, detail.source.original_text);
    assert.equal(source.get('source-original-details').open, true);
    assert.equal(source.get('source-active-evidence').focused, true);
  }

  // 5. Incorrect, unverified or out-of-bounds locators cannot offer a jump.
  for (const changed of [
    { text: '采用右衽设计。' }, { locator_verified: false }, { end: 9999 }, { start: null, end: null },
  ]) {
    const data = clone(detail);
    Object.assign(data.evidence[1], changed);
    const invalidLocator = page('source', '/source.html?id=1', data);
    invalidLocator.start(); await settle();
    assert.equal(invalidLocator.get('source-content').hidden, false);
    assert.equal(buttons(invalidLocator.get('source-evidence')).length, 1);
    assert.match(invalidLocator.get('source-evidence').textContent, /请展开原文核对/);
    assert.equal(invalidLocator.get('source-original').textContent, data.source.original_text);
  }

  // 6. Only absolute HTTP(S) original-source URLs become clickable links.
  const external = anchors(source.get('source-metadata'));
  assert.equal(external.length, 1);
  assert.equal(external[0].href, detail.source.source_url);
  assert.equal(external[0].rel, 'noopener noreferrer');
  for (const url of ['javascript:alert(1)', 'data:text/html,unsafe', '//example.invalid/source', '']) {
    const data = clone(detail); data.source.source_url = url;
    const unsafe = page('source', '/source.html?id=1', data);
    unsafe.start(); await settle();
    assert.equal(anchors(unsafe.get('source-metadata')).length, 0);
    assert.match(unsafe.get('source-metadata').textContent, /原始链接暂不可用/);
  }

  // 7. Catalog count/identity inconsistencies show errors and allow a retry.
  for (const corrupt of [
    data => { data.stats.approved_evidence += 1; },
    data => { data.sources[1].id = data.sources[0].id; },
  ]) {
    const data = clone(catalog); corrupt(data);
    const invalid = page('library', '/library.html', data);
    invalid.start(); await settle();
    assert.equal(invalid.get('library-status').dataset.state, 'error');
    assert.equal(invalid.get('library-list').children.length, 0);
    assert.equal(invalid.get('source-total').textContent, '—');
    assert.equal(invalid.get('evidence-total').textContent, '—');
    assert.equal(invalid.get('library-retry').hidden, false);
    invalid.respond(catalog); await invalid.get('library-retry').click();
    assert.equal(invalid.get('library-status').dataset.state, 'ready');
    assert.equal(invalid.get('library-list').children.length, 12);
  }

  // 8. Incorrect object/evidence assignments and missing sources stay hidden.
  const wrongObject = clone(detail); wrongObject.objects[0].evidence_ids = [11];
  for (const [data, status] of [[wrongObject, 200], [{ error: 'not found' }, 404]]) {
    const invalid = page('source', '/source.html?id=1', data, status);
    invalid.start(); await settle();
    assert.equal(invalid.get('source-status').dataset.state, 'error');
    assert.equal(invalid.get('source-content').hidden, true);
    assert.equal(invalid.get('source-retry').hidden, false);
    assert.match(invalid.get('source-status').textContent, /格式异常|暂不可用/);
    invalid.respond(detail); await invalid.get('source-retry').click();
    assert.equal(invalid.get('source-content').hidden, false);
    assert.equal(invalid.get('source-feedback').hidden, true);
  }

  // 9. Both pages surface timed-out reads, then recover on an explicit retry.
  for (const [name, address, data] of [
    ['library', '/library.html', catalog], ['source', '/source.html?id=1', detail],
  ]) {
    const stalled = page(name, address, data);
    stalled.stall(); stalled.start(); await settle();
    assert.equal(stalled.get(`${name}-status`).dataset.state, 'loading');
    stalled.expireRequests(); await settle();
    assert.equal(stalled.get(`${name}-status`).dataset.state, 'error');
    assert.match(stalled.get(`${name}-status`).textContent, /超时/);
    assert.equal(stalled.get(`${name}-retry`).hidden, false);
    if (name === 'source') assert.equal(stalled.get('source-content').hidden, true);
    else assert.equal(stalled.get('library-list').children.length, 0);
    stalled.respond(data); await stalled.get(`${name}-retry`).click();
    if (name === 'source') assert.equal(stalled.get('source-content').hidden, false);
    else assert.equal(stalled.get('library-status').dataset.state, 'ready');
  }

  // 10. Invalid detail IDs fail locally and never request an unrelated source.
  for (const id of ['', '0', '-1', '01', '1.0', '1e0', '9007199254740992']) {
    const invalid = page('source', `/source.html?id=${encodeURIComponent(id)}`, detail);
    invalid.start(); await settle();
    assert.deepEqual(invalid.requests, []);
    assert.equal(invalid.get('source-content').hidden, true);
    assert.equal(invalid.get('source-status').dataset.state, 'error');
    assert.match(invalid.get('source-status').textContent, /编号无效/);
  }
  console.log('PASS: 10 library/detail frontend scenarios, including filters/navigation, Unicode locators, URL safety, malformed data and timeout recovery');
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { page, catalog, detail, settle, descendants, clone, visibleIds, anchors, buttons };

/* Source chooser contract and workbench integration against production scripts.
 * Run: node tests/test_source_picker.cjs
 * Disposable DOM/HTTP/Storage fixtures only; no real network, model or database.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { await tick(); await tick(); };
const allBelow = node => (node.children || []).flatMap(child => [child, ...allBelow(child)]);
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => clone(data) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sourceNames = [
  '新疆喀什维吾尔族绿棉袍', '新疆喀什维吾尔族花帽', '新疆艾德莱斯绸头巾',
  '新疆喀什牛皮女靴', '新疆维吾尔族印花模戳', '哈密维吾尔族刺绣',
  '2024年新中式衬衣', '2023年时尚秀设计', '于田手工褡裢', '于田裙子', '旧文献资料', '黑色羔皮帽',
];
const basicSources = () => sourceNames.map((title, index) => ({ id: index + 1, title, object_name: title }));
const catalog = () => ({
  stats: { available_sources: sourceNames.length, approved_evidence: sourceNames.length },
  attributes: ['形制', '材质'], publishers: ['示例民族服饰馆'],
  sources: basicSources().map((item, index) => ({
    id: item.id, title: item.title, object_names: [item.object_name], publisher: '示例民族服饰馆',
    aliases: index === 0 ? ['长袍', '喀什棉袍'] : index === 1 ? ['朵帕'] : [],
    catalog_numbers: index === 0 ? ['MFB002865'] : [],
    attributes: ['形制', '材质'], keywords: index === 0 ? ['对襟', '棉布'] : [],
    evidence_count: 1, visual_count: 0, cover: null,
    source_url: `https://example.invalid/source/${item.id}`, excerpt: '界面测试摘要。', retrieved_at: '2026-10-18',
  })),
});

function pickerHarness({ data = catalog(), status = 200, supported = true, pending = null } = {}) {
  const ids = new Map();
  let focused = null;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.attrs = {};
      this.events = {}; this.hidden = false; this.disabled = false; this.open = false; this.parentElement = null;
      this.className = ''; this._text = ''; this._value = '';
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(' ').filter(name => !names.includes(name)).join(' '); },
        contains: name => this.className.split(' ').includes(name),
        toggle: (name, force) => { const enabled = force === undefined ? !this.classList.contains(name) : force; if (enabled) this.classList.add(name); else this.classList.remove(name); return enabled; },
      };
    }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
    set value(value) { const text = String(value); this._value = this.tagName === 'select' && !this.children.some(option => option.value === text) ? '' : text; }
    get value() { return this._value; }
    get options() { return this.children; }
    get selectedOptions() { return this.children.filter(option => option.value === this.value); }
    append(...children) { for (let child of children) { if (typeof child === 'string') child = { textContent: child }; child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key]; }
    addEventListener(type, callback) { this.events[type] = callback; }
    focus() { focused = this; }
    scrollIntoView(options) { this.lastScroll = options; }
    showModal() { this.open = true; }
    close() { this.open = false; this.events.close?.({}); }
    click() { if (!this.disabled) return this.events.click?.({ currentTarget: this, target: this, preventDefault() {} }); }
  }
  const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1]); node.id = match[2]; node.hidden = /\bhidden\b/.test(match[0]);
  }
  const select = ids.get('source-select'); select.append(new Element('option'));
  if (!supported) ids.get('source-picker-dialog').showModal = undefined;
  const timers = new Map(); let nextTimer = 0; const requests = []; let commits = 0; let result = pending || response(data, status);
  const document = {
    getElementById: id => ids.get(id), querySelector: selector => ids.get(selector.slice(1)),
    createElement: tag => new Element(tag), get activeElement() { return focused; },
  };
  const window = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, addEventListener() {},
  };
  const context = vm.createContext({ document, window, console, URL, AbortController,
    fetch: async (route, options = {}) => { requests.push(route); return result; },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend/source-picker.js'), 'utf8'), context);
  const picker = window.SourcePicker.create({ select, onSelect() { commits++; } });
  return { ids, select, picker, requests, document, Element,
    get commits() { return commits; },
    respond(value, code = 200) { result = response(value, code); },
    defer(value) { result = value; },
    async setSources(sources = basicSources()) {
      for (const source of sources) if (!select.children.some(option => option.value === String(source.id))) {
        const option = new Element('option'); option.value = String(source.id); option.textContent = source.title; select.append(option);
      }
      picker?.setSources(clone(sources)); picker?.sync(); await settle();
    },
    setUnavailable(id = 404) { const option = new Element('option'); option.value = String(id); option.textContent = `草稿所用资料 #${id}（当前不可用）`; select.append(option); select.value = String(id); picker.sync(); },
    input(value) { const input = ids.get('source-picker-search'); input.value = value; input.events.input({ currentTarget: input, target: input }); },
    expire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
  };
}
const node = (h, id) => { const result = h.ids.get(id); assert.ok(result, id); return result; };
const cards = h => node(h, 'source-picker-list').children;
const visibleIds = h => cards(h).map(card => Number(card.dataset.sourceId));
const buttons = h => allBelow(node(h, 'source-picker-list')).filter(item => item.tagName === 'button' && item.dataset.sourceId);
const choose = (h, id) => { const button = buttons(h).find(item => Number(item.dataset.sourceId) === id); assert.ok(button, `source ${id}`); return button.click(); };
const category = (h, key) => { const button = allBelow(node(h, 'source-picker-categories')).find(item => item.dataset.category === key); assert.ok(button, `category ${key}`); return button; };
const open = h => { node(h, 'source-picker-open').click(); assert.equal(node(h, 'source-picker-dialog').open, true); };
const cases = [];
const test = (name, body) => cases.push([name, body]);
const activeWorkbenches = new Set();
async function workbench() {
  const harnessPath = require.resolve('./test_workflow_frontend.cjs'); delete require.cache[harnessPath];
  const h = require(harnessPath); activeWorkbenches.add(h); await h.flush(); await h.flush(); return h;
}

test('progressive enhancement leaves unsupported native selection usable', async () => {
  const fallback = pickerHarness({ supported: false });
  assert.equal(fallback.picker, null);
  assert.equal(node(fallback, 'source-native-field').hidden, false);
  assert.equal(node(fallback, 'source-picker-open').hidden, true);
  assert.deepEqual(fallback.requests, []);
  const h = pickerHarness();
  assert.deepEqual(h.requests, [], 'Creating UI does not fetch before a source baseline exists.');
  await h.setSources();
  assert.deepEqual(h.requests, ['/api/library']);
  assert.equal(node(h, 'source-native-field').hidden, true);
  assert.equal(h.select.value, ''); assert.equal(h.commits, 0);
  open(h); assert.equal(h.document.activeElement.id, 'source-picker-search');
  assert.deepEqual(visibleIds(h), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(node(h, 'source-picker-status').textContent, /12.*8/);
  await h.setSources(); assert.equal(h.requests.length, 1, 'Unchanged baseline reuses metadata.');
});

test('name aliases catalog identifiers and all query tokens match without committing', async () => {
  const h = pickerHarness(); await h.setSources(); open(h);
  for (const [query, ids] of [['长袍', [1]], ['朵帕', [2]], ['ｍｆｂ００２８６５', [1]],
    ['  MFB002865  ', [1]], ['长袍 对襟', [1]], ['长袍 羔皮帽', []], ['艾特莱丝 头巾', [3]]]) {
    h.input(query); assert.deepEqual(visibleIds(h), ids, query);
  }
  assert.equal(h.select.value, ''); assert.equal(h.commits, 0);
  assert.equal(node(h, 'source-picker-reset').hidden, false);
  node(h, 'source-picker-reset').click();
  assert.equal(node(h, 'source-picker-search').value, '');
  assert.equal(node(h, 'source-picker-reset').hidden, true);
  let prevented = false; node(h, 'source-picker-search').events.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.commits, 0);
});

test('category counts partition eligible sources and intersect search', async () => {
  const h = pickerHarness(); await h.setSources(); open(h);
  const expected = { all: 12, clothing: 2, headwear: 3, accessories: 2, textiles: 1, embroidery: 1, contemporary: 2, other: 1 };
  for (const [key, count] of Object.entries(expected)) assert.ok(category(h, key).textContent.endsWith(` ${count}`), `${key}: ${category(h, key).textContent}`);
  category(h, 'headwear').click();
  assert.deepEqual(visibleIds(h), [2, 3, 12]);
  assert.equal(category(h, 'headwear').getAttribute('aria-pressed'), 'true');
  h.input('羔皮'); assert.deepEqual(visibleIds(h), [12]);
  assert.ok(category(h, 'headwear').textContent.endsWith(' 3'), 'Category counts describe all eligible records, not just current search.');
  category(h, 'clothing').click(); assert.deepEqual(visibleIds(h), []);
  assert.equal(node(h, 'source-picker-empty').hidden, false);
  node(h, 'source-picker-reset').click();
  assert.equal(category(h, 'all').getAttribute('aria-pressed'), 'true');
  assert.equal(cards(h).length, 8); assert.equal(h.commits, 0);
});

test('pagination reset and selected summaries preserve the canonical source', async () => {
  const h = pickerHarness(); await h.setSources(); open(h);
  node(h, 'source-picker-more').click(); assert.deepEqual(visibleIds(h), basicSources().map(item => item.id));
  assert.equal(node(h, 'source-picker-more').hidden, true);
  choose(h, 10); assert.equal(h.select.value, '10'); assert.equal(h.commits, 1);
  assert.equal(node(h, 'source-picker-dialog').open, false);
  assert.equal(h.document.activeElement.id, 'source-picker-open');
  assert.equal(node(h, 'source-picker-summary').dataset.state, 'selected');
  assert.match(node(h, 'source-picker-summary').textContent, /于田裙子/);
  open(h); h.input('朵帕'); assert.deepEqual(visibleIds(h), [2]);
  assert.equal(h.select.value, '10'); assert.match(node(h, 'source-picker-summary').textContent, /于田裙子/);
  node(h, 'source-picker-reset').click(); assert.equal(cards(h).length, 8);
  node(h, 'source-picker-dialog').events.cancel({ preventDefault() {} });
  assert.equal(node(h, 'source-picker-dialog').open, false);
  assert.equal(h.select.value, '10'); assert.equal(h.commits, 1);
});

test('retained unavailable selections never become selectable through metadata', async () => {
  const data = catalog(); data.sources.push({ ...clone(data.sources[0]), id: 404, title: '无审核资格的资料', object_names: ['无审核资格的资料'] });
  const h = pickerHarness({ data }); await h.setSources(); h.setUnavailable(); open(h);
  assert.equal(h.select.value, '404'); assert.equal(node(h, 'source-picker-summary').dataset.state, 'unavailable');
  assert.match(node(h, 'source-picker-summary').textContent, /404.*当前不可用/);
  node(h, 'source-picker-more').click(); assert.equal(visibleIds(h).includes(404), false);
  assert.ok(category(h, 'all').textContent.endsWith(' 12'));
  h.input('无审核资格'); assert.deepEqual(visibleIds(h), []); assert.equal(h.select.value, '404');
  node(h, 'source-picker-reset').click(); choose(h, 1);
  assert.equal(h.select.value, '1'); assert.equal(h.commits, 1);
});

test('busy state closes dialog and stale handlers cannot change source or filters', async () => {
  const h = pickerHarness(); await h.setSources(); open(h);
  const use = buttons(h)[0]; const oldCategory = category(h, 'headwear');
  const initial = visibleIds(h); const requestCount = h.requests.length;
  h.select.disabled = true; h.picker.sync();
  assert.equal(node(h, 'source-picker-dialog').open, false);
  for (const id of ['source-picker-open', 'source-picker-search', 'source-picker-reset', 'source-picker-retry', 'source-picker-more']) assert.equal(node(h, id).disabled, true, id);
  use.events.click({}); oldCategory.events.click({});
  node(h, 'source-picker-more').events.click({}); node(h, 'source-picker-retry').events.click({});
  assert.equal(h.select.value, ''); assert.equal(h.commits, 0); assert.equal(h.requests.length, requestCount);
  assert.deepEqual(visibleIds(h), initial);
  h.select.disabled = false; h.picker.sync(); open(h); choose(h, 1);
  assert.equal(h.select.value, '1'); assert.equal(h.commits, 1);
});

test('metadata failure and delayed replies never block basic source selection', async () => {
  const wait = deferred(); const h = pickerHarness({ pending: wait.promise });
  await h.setSources(); open(h);
  assert.match(node(h, 'source-picker-status').textContent, /正在补充/);
  h.input('棉袍'); assert.deepEqual(visibleIds(h), [1]); choose(h, 1);
  assert.equal(h.select.value, '1'); assert.equal(h.commits, 1);
  wait.resolve(response({ error: 'unavailable' }, 503)); await settle(); open(h);
  assert.equal(node(h, 'source-picker-status').dataset.state, 'partial');
  assert.equal(node(h, 'source-picker-retry').hidden, false);
  h.respond(catalog()); node(h, 'source-picker-retry').click(); await settle();
  assert.equal(node(h, 'source-picker-status').dataset.state, 'ready');
  h.input('长袍'); assert.deepEqual(visibleIds(h), [1]);
  assert.equal(h.select.value, '1'); assert.equal(h.commits, 1);
});

test('changed baselines reject stale async metadata and stale selection buttons', async () => {
  const old = deferred(); const h = pickerHarness({ pending: old.promise }); await h.setSources(); open(h);
  const staleUse = buttons(h)[0];
  const nextData = catalog(); nextData.sources = nextData.sources.filter(item => item.id === 2);
  h.respond(nextData); await h.setSources(basicSources().filter(item => item.id === 2));
  assert.deepEqual(visibleIds(h), [2]);
  const staleData = catalog(); staleData.sources[1].aliases = ['过期错误别名'];
  old.resolve(response(staleData)); await settle();
  h.input('过期错误别名'); assert.deepEqual(visibleIds(h), []);
  staleUse.events.click({}); assert.equal(h.select.value, ''); assert.equal(h.commits, 0);
  h.input('朵帕'); assert.deepEqual(visibleIds(h), [2]); choose(h, 2); assert.equal(h.select.value, '2');
});

test('unsafe metadata falls back and hostile content stays inert', async () => {
  for (const mutate of [
    data => { data.sources[0].cover = { url: 'javascript:alert(1)', alt: 'x', width: 10, height: 10 }; data.sources[0].visual_count = 1; },
    data => { data.sources[0].cover = { url: '/img/library/../x.jpg', alt: 'x', width: 10, height: 10 }; data.sources[0].visual_count = 1; },
    data => { data.sources[0].aliases = '<script>x</script>'; },
    data => { data.sources.push(clone(data.sources[0])); },
  ]) {
    const data = catalog(); mutate(data); const h = pickerHarness({ data }); await h.setSources(); open(h);
    assert.equal(node(h, 'source-picker-status').dataset.state, 'partial');
    assert.equal(allBelow(node(h, 'source-picker-list')).filter(item => item.tagName === 'img').length, 0);
    h.input('棉袍'); choose(h, 1); assert.equal(h.select.value, '1');
  }
  const data = catalog(); data.sources[0].object_names = ['<img src=x onerror=alert(1)>'];
  data.sources[0].aliases = ['<script>alert(1)</script>']; data.sources[0].source_url = 'javascript:alert(1)';
  const h = pickerHarness({ data }); await h.setSources(); open(h);
  assert.match(node(h, 'source-picker-list').textContent, /<img src=x/);
  assert.equal(allBelow(node(h, 'source-picker-list')).filter(item => item.tagName === 'script').length, 0);
  const links = allBelow(node(h, 'source-picker-list')).filter(item => item.tagName === 'a');
  assert.ok(links.every(link => link.href.startsWith('./source.html?id=')
    && /^[1-9][0-9]*$/.test(link.href.slice('./source.html?id='.length))));
  assert.ok(links.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer'));
});

test('editing search leaves drafts untouched and explicit choose saves exactly once', async () => {
  const h = await workbench();
  h.ids.get('document-preview').value = '我的待审阅正文。'; h.ids.get('document-preview').events.input(); h.run('flushDraftSave()');
  const initialRaw = h.storageData.get('cmit:workspace-draft:v1:new');
  h.run('pickerDraftQueueCount = 0; originalPickerQueue = queueDraftSave; queueDraftSave = function() { pickerDraftQueueCount++; return originalPickerQueue(); }');
  open(h); node(h, 'source-picker-search').value = '棉袍'; node(h, 'source-picker-search').events.input();
  category(h, 'clothing').click();
  assert.equal(h.run('pickerDraftQueueCount'), 0);
  assert.equal(h.storageData.get('cmit:workspace-draft:v1:new'), initialRaw);
  choose(h, 1); assert.equal(h.run('pickerDraftQueueCount'), 1);
  h.run('flushDraftSave()');
  const saved = JSON.parse(h.storageData.get('cmit:workspace-draft:v1:new'));
  assert.equal(saved.source_id, 1); assert.equal(saved.text, '我的待审阅正文。');
  assert.equal(node(h, 'review-document').disabled, false);
  assert.equal(h.requests.some(route => route === '/api/review' || route.endsWith('/decisions')), false);
});

test('deep links history and clear synchronize selection without implicit review', async () => {
  const h = await workbench(); h.setAddress('/?source=1'); await h.run('initializeWorkspace()');
  assert.equal(node(h, 'source-select').value, '1'); assert.equal(node(h, 'source-picker-summary').dataset.state, 'selected');
  assert.equal(h.run('currentRecord'), null);
  h.setAddress(`/?review=${h.record.review_id}&source=404`); await h.run('initializeWorkspace()');
  assert.equal(node(h, 'source-select').value, '1'); assert.equal(h.run('hasDraftChanges()'), false);
  h.run('handleClear()');
  assert.equal(node(h, 'source-select').value, ''); assert.equal(node(h, 'source-picker-summary').dataset.state, 'empty');
  h.setAddress('/?source=404'); await h.run('initializeWorkspace()');
  assert.equal(node(h, 'source-select').value, ''); assert.equal(node(h, 'review-document').disabled, true);
  assert.equal(h.requests.includes('/api/review'), false);
});

test('history source is retained while sources arrive and unavailable drafts remain explicit', async () => {
  const h = await workbench();
  const slow = deferred(); h.sourcesResponse = slow.promise; h.setAddress(`/?review=${h.record.review_id}`);
  const initializing = h.run('initializeWorkspace()'); await h.flush();
  assert.equal(node(h, 'source-picker-open').disabled, true);
  slow.resolve(h.response(h.sourcesData)); await initializing;
  assert.equal(node(h, 'source-select').value, '1'); assert.equal(node(h, 'source-picker-summary').dataset.state, 'selected');
  h.run('handleClear()');
  node(h, 'document-preview').value = '草稿正文。'; node(h, 'document-preview').events.input(); h.run('flushDraftSave()');
  const draft = JSON.parse(h.storageData.get('cmit:workspace-draft:v1:new')); draft.source_id = 404;
  h.storageData.set('cmit:workspace-draft:v1:new', JSON.stringify(draft));
  h.run('initializeDrafts(); recoverLocalDraft()');
  assert.equal(node(h, 'source-select').value, '404');
  assert.equal(node(h, 'source-picker-summary').dataset.state, 'unavailable');
  assert.equal(node(h, 'review-document').disabled, true);
  open(h); assert.equal(visibleIds(h).includes(404), false);
});

test('all workbench busy flags lock explicit choose handlers and guide focuses visible search', async () => {
  const h = await workbench();
  for (const busy of ['workspaceInitializing', 'activeUpload', 'activeReview', 'activeHistory', 'activeSave', 'activeSourceSelection', 'activeExampleLoad']) {
    open(h); const staleUse = buttons(h)[0];
    h.run(`${busy} = true; syncWorkspace()`);
    assert.equal(node(h, 'source-picker-open').disabled, true, busy);
    assert.equal(node(h, 'source-picker-dialog').open, false, busy);
    staleUse.events.click({}); assert.equal(node(h, 'source-select').value, '', busy);
    h.run(`${busy} = false; syncWorkspace()`);
  }
  node(h, 'document-preview').value = '我的正文。'; node(h, 'document-preview').events.input();
  node(h, 'guide-next').click();
  assert.equal(h.document.activeElement.id, 'source-picker-search');
  assert.equal(node(h, 'source-picker-dialog').open, true);
  assert.equal(h.requests.includes('/api/review'), false);
});

test('common garment names stable order and repeated selection stay predictable', async () => {
  const data = catalog(); data.sources[0].aliases.push('长袖袍', '宽身袍', '未展示别称');
  const h = pickerHarness({ data }); await h.setSources(basicSources().reverse()); open(h);
  assert.deepEqual(visibleIds(h), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const [query, ids] of [['帽子', [2, 12]], ['鞋子', [4]], ['靴子', [4]], ['袍子', [1]], ['未展示别称', [1]]]) {
    h.input(query); assert.deepEqual(visibleIds(h), ids, query);
  }
  choose(h, 1); assert.equal(h.commits, 1);
  open(h); choose(h, 1); assert.equal(h.commits, 1, 'Reconfirming the same source must not dirty the draft again.');
  assert.equal(node(h, 'source-picker-dialog').open, false);
});

(async () => {
  for (const [name, body] of cases) {
    try { await body(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    finally { for (const h of activeWorkbenches) h.close(); activeWorkbenches.clear(); }
  }
  console.log(`PASS: ${cases.length} source picker scenarios, including search, category filters, explicit selection, async fallback, busy guards and draft/history/guide integration`);
})().catch(error => { console.error(error); process.exitCode = 1; });

/* Dependency-free frontend workflow regression tests.
 * Run: node tests/test_workflow_frontend.cjs
 * The real app.js runs against a deliberately small DOM and HTTP harness.
 * Browser validation remains responsible for layout, uploads and accessibility.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const ids = new Map();
const all = [];
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.attrs = {}; this.events = {}; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.className = ''; this.parentElement = null; this.files = []; this.selectionStart = 0; this.selectionEnd = 0; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.classList = { add: (...items) => this.className += ' ' + items.join(' '), remove: (...items) => { this.className = this.className.split(' ').filter(c => !items.includes(c)).join(' '); }, toggle: (name, value) => value ? this.classList.add(name) : this.classList.remove(name), contains: name => this.className.split(' ').includes(name) }; all.push(this); }
  set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id; }
  get value() { return this._value || ''; }
  set value(value) {
    const text = String(value);
    this._value = this.tagName === 'select' && !this.children.some(option => option.value === text) ? '' : text;
  }
  get options() { return this.children; }
  append(...items) { items.forEach(item => { if (typeof item === 'string') item = { textContent: item }; item.parentElement = this; this.children.push(item); }); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name]; }
  addEventListener(type, fn) { this.events[type] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.({}); }
  querySelector(selector) { return this.children.find(node => node.className?.split(' ').includes(selector.slice(1))) || new Node(); }
  scrollIntoView(options) { this.lastScrollIntoView = options || {}; }
  setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  focus() { focused = this; }
  click() {
    if (this.tagName === 'a' && this.download) downloadLinks.push({ href: this.href, download: this.download });
    if (this.events.click) return this.events.click({});
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); }
}
let focused;
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) { const n = new Node(match[1]); n.id = match[2]; n.hidden = /\bhidden\b/.test(match[0]); }
// The workspace must work without any archive-list DOM. Archives live on a
// separate page; leave these absent even if a future template adds old markup.
for (const id of ['refresh-history', 'history-list', 'history-count', 'history-status']) ids.delete(id);
ids.get('source-select').append(new Node('option'));
ids.get('progress-fill').parentElement = new Node();
const scanTitle = new Node();
const documentEvents = new Map();
const document = {
  body: new Node('body'), createElement: tag => new Node(tag), createTextNode: text => ({ textContent: text }),
  get activeElement() { return focused; },
  getElementById: id => ids.get(id),
  addEventListener(type, handler) { documentEvents.set(type, handler); },
  querySelector: selector => selector === '#review-progress-box .scan-title' ? scanTitle : ids.get(selector.slice(1)),
  querySelectorAll: selector => all.filter(n => n.className.split(' ').includes(selector.slice(1)))
};
// Explicit test data: one supported, one insufficient and one uncovered sentence.
// These are interface fixtures, not model predictions or an accuracy evaluation.
const sentences = ['这件棉袍采用对襟设计。', '这件棉袍的主人喜欢音乐。', '未知藏品采用圆领设计。'];
let offset = 0;
const results = sentences.map((sentence, index) => {
  const start = offset;
  offset += Array.from(sentence).length + 1;
  return {
    index, sentence, sentence_start: start, sentence_end: offset - 1,
    status: ['supported', 'insufficient', 'uncovered'][index],
    reason: ['model_supports', 'model_insufficient', 'no_evidence'][index],
    message: ['模型判为支持，请人工核对。', '证据未提及主人喜好。', '未检索到可比对证据。'][index],
    evidence: index === 2 ? [] : [{
      evidence_id: 1, source_id: 1, evidence: '棉袍采用对襟设计。',
      object_name: '棉袍', source_title: '测试资料',
      source_url: 'https://example.invalid/costume', locator: '测试段落 1',
      stance: index === 0 ? 'supports' : 'insufficient', relevance: 0.8,
      scores: index === 0
        ? { supports: 0.9, refutes: 0.05, insufficient: 0.05 }
        : { supports: 0.05, refutes: 0.05, insufficient: 0.9 },
    }],
  };
});
const fixture = {
  schema_version: 2, normalized_text: sentences.join('\n'),
  offset_basis: 'normalized_text_python_chars', results, problems: [],
  stats: {
    total_sentences: 3, checked_sentences: 2, problems_found: 0,
    supported_sentences: 1, refuted_sentences: 0, insufficient_sentences: 1,
    conflicting_sentences: 0, uncovered_sentences: 1,
    no_evidence_sentences: 1, low_relevance_sentences: 0, noise_sentences: 0,
    coverage_ratio: 2 / 3,
  },
};
const clone = x => JSON.parse(JSON.stringify(x));
const record = { ...fixture, review_id: 'a'.repeat(32), title: '棉袍展签', source_id: 1, parent_id: null, created_at: '2026-10-17T03:00:00Z', model_version: 'fixture-model', decisions_revision: 0, decisions: fixture.results.map(r => ({ index: r.index, state: 'unreviewed', note: '' })) };
let lastBody;
let saveMode = 'ok';
let saveResponse = null;
let reportMode = 'ok';
let reportBlob = null;
let lastReportPath;
let reportDownloads = 0;
const downloadLinks = [];
let saved = clone(record);
let decisionRecord = record;
let historyUnavailable = false;
const response = (data, status = 200) => ({ ok: status === 200, status, headers: { get: () => 'application/json' }, json: async () => data });
const requests = [];
const sourcesData = { approved_count: 1, sources: [{ id: 1, title: '资料一', object_name: '棉袍' }] };
let sourcesResponse = null;
let reviewResponse = null;
let extractResponse = null;
let libraryResponse = null;
let libraryCatalogResponse = null;
const libraryCatalog = () => ({
  stats: { available_sources: sourcesData.sources.length, approved_evidence: sourcesData.sources.length },
  attributes: ['形制'], publishers: ['界面测试资料馆'],
  sources: sourcesData.sources.map(source => ({
    id: source.id, title: source.title, publisher: '界面测试资料馆',
    source_url: `https://example.invalid/source/${source.id}`, retrieved_at: '2026-10-17',
    object_names: [source.object_name], aliases: [], attributes: ['形制'], keywords: [], catalog_numbers: [],
    excerpt: '仅供界面测试的资料摘要。', evidence_count: 1, visual_count: 0, cover: null,
  })),
});
const fetch = async (path, options = {}) => {
  requests.push(path);
  if (path === '/api/sources') return sourcesResponse || response(sourcesData);
  if (path === '/api/library') return libraryCatalogResponse || response(libraryCatalog());
  if (/^\/api\/library\/[1-9][0-9]*$/.test(path) && libraryResponse) return libraryResponse;
  if (path === '/api/reviews') throw new Error('The workspace must not request the archive list');
  if (path === '/api/extract' && extractResponse) return extractResponse;
  if (path.endsWith('/decisions')) {
    lastBody = JSON.parse(options.body);
    if (saveResponse) return saveResponse;
    if (saveMode === 'conflict') return response({ error: 'changed' }, 409);
    saved = { ...clone(decisionRecord), decisions_revision: lastBody.expected_revision + 1, decisions: clone(lastBody.decisions) };
    return response(saved);
  }
  if (new URL(path, 'http://localhost').pathname.endsWith('/report')) {
    lastReportPath = path;
    if (reportMode === 'conflict') return response({ error: '处理记录已更新，请重新打开记录后导出。' }, 409);
    return { ok: true, headers: { get: () => 'text/html; charset=utf-8' },
      blob: () => reportBlob || Promise.resolve(new Blob(['report'])) };
  }
  if (path === '/api/review') {
    lastBody = JSON.parse(options.body);
    if (reviewResponse) return reviewResponse;
    return response({ ...clone(record), review_id: 'b'.repeat(32), title: lastBody.title, parent_id: lastBody.parent_id || null });
  }
  if (path === `/api/reviews/${record.review_id}`) return historyUnavailable
    ? response({ error: '档案服务暂时不可用，请重试。' }, 503) : response(saved);
  throw new Error(path);
};
const timers = new Set();
const trackedTimeout = (callback, delay) => {
  const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
  timers.add(timer); return timer;
};
const trackedInterval = (callback, delay) => {
  const timer = setInterval(callback, delay); timers.add(timer); return timer;
};
const clearTimer = (timer) => { clearTimeout(timer); clearInterval(timer); timers.delete(timer); };
const windowEvents = new Map();
// An inspectable Storage implementation lets the draft suite exercise refresh,
// competing tabs and unavailable storage without touching any real browser data.
const storageData = new Map();
const localStorage = {
  error: null,
  get length() { return storageData.size; },
  key(index) { return [...storageData.keys()][index] ?? null; },
  getItem(key) { if (this.error) throw this.error; return storageData.get(String(key)) ?? null; },
  setItem(key, value) { if (this.error) throw this.error; storageData.set(String(key), String(value)); },
  removeItem(key) { if (this.error) throw this.error; storageData.delete(String(key)); },
  clear() { if (this.error) throw this.error; storageData.clear(); },
};
const replacements = [];
const location = {
  protocol: 'http:', origin: 'http://localhost', pathname: '/', search: '', hash: '', href: 'http://localhost/',
};
const setAddress = address => {
  const url = new URL(address, location.href);
  for (const key of ['protocol', 'origin', 'pathname', 'search', 'hash', 'href']) location[key] = url[key];
};
const context = vm.createContext({
  document, window: {
    location, localStorage, confirm: () => true,
    setTimeout: trackedTimeout, clearTimeout: clearTimer,
    history: { replaceState(state, title, address) { replacements.push(address); setAddress(address); } },
    addEventListener(type, handler) { windowEvents.set(type, handler); },
  },
  fetch, AbortController, setTimeout: trackedTimeout, clearTimeout: clearTimer,
  setInterval: trackedInterval, clearInterval: clearTimer, requestAnimationFrame: f => f(),
  URL: class extends URL {
    static createObjectURL() { reportDownloads++; return 'blob:report'; }
    static revokeObjectURL() {}
  }, URLSearchParams, Blob, console, TextDecoder, record, clone,
});
for (const script of ['sentence-map.js', 'draft-store.js', 'workspace-drafts.js', 'workspace-guide.js', 'source-picker.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend', script), 'utf8'), context, { filename: script });
}
const run = code => vm.runInContext(code, context);
const flush = () => new Promise(resolve => setImmediate(resolve));
// Importing this file supplies a fresh harness, never the 53 legacy scenarios.
// The separate draft suite resets the require cache between isolated scenarios.
module.exports = {
  ids, Node, document, documentEvents, windowEvents, localStorage, storageData,
  requests, downloadLinks, location, setAddress, context, run, flush,
  record, fixture, clone, response, sourcesData, libraryCatalog,
  get saved() { return saved; }, set saved(value) { saved = value; },
  get lastBody() { return lastBody; },
  set reviewResponse(value) { reviewResponse = value; },
  set extractResponse(value) { extractResponse = value; },
  set saveResponse(value) { saveResponse = value; },
  set saveMode(value) { saveMode = value; },
  set historyUnavailable(value) { historyUnavailable = value; },
  set sourcesResponse(value) { sourcesResponse = value; },
  set libraryResponse(value) { libraryResponse = value; },
  set libraryCatalogResponse(value) { libraryCatalogResponse = value; },
  close() { timers.forEach(clearTimer); },
};
if (require.main === module) (async () => {
  await flush();
  // 1. Workspace startup has no archive-list DOM or archive-list request.
  assert.equal(ids.has('history-list'), false);
  assert.deepEqual(requests, ['/api/sources', '/api/library']);
  // 2. A linked record opens after delayed source options become available.
  setAddress(`/?review=${record.review_id}`);
  ids.get('source-select').replaceChildren(new Node('option'));
  run('availableSourceIds = new Set()');
  let resolveSources;
  sourcesResponse = new Promise(resolve => { resolveSources = resolve; });
  const startupRequests = requests.length;
  const linkedStartup = run('initializeWorkspace()');
  await flush();
  resolveSources(response(sourcesData));
  await linkedStartup;
  sourcesResponse = null;
  assert.equal(run('currentRecord.review_id'), record.review_id);
  assert.equal(ids.get('source-select').value, '1');
  assert.equal(run('availableSourceIds.has(1)'), true);
  assert.deepEqual(requests.slice(startupRequests).filter(path => path !== '/api/library').sort(), ['/api/sources', `/api/reviews/${record.review_id}`].sort());
  assert.equal(run('hasDraftChanges()'), false);
  // 3. Clearing a restored record removes its address, preventing resurrection.
  run('handleClear()');
  assert.equal(run('currentRecord'), null);
  assert.equal(new URLSearchParams(location.search).has('review'), false);
  assert.equal(replacements.length > 0, true);
  // 4. Invalid record links show a useful error without requesting that record.
  setAddress('/?review=not-a-record');
  const invalidRequests = requests.length;
  await run('initializeWorkspace()');
  assert.deepEqual(requests.slice(invalidRequests).filter(path => path !== '/api/library'), ['/api/sources']);
  assert.equal(run('currentRecord'), null);
  assert.match(ids.get('workflow-status').textContent, /无效|不正确|不合法|格式/);
  // 5. A failed linked-record load can be retried from its original address.
  setAddress(`/?review=${record.review_id}&from=archive#workspace`);
  historyUnavailable = true;
  await run('initializeWorkspace()');
  assert.equal(run('currentRecord'), null);
  assert.equal(ids.get('retry-history').hidden, false);
  assert.match(ids.get('workflow-status').textContent, /不可用/);
  historyUnavailable = false;
  await ids.get('retry-history').click();
  assert.equal(run('currentRecord.review_id'), record.review_id);
  assert.equal(ids.get('retry-history').hidden, true);
  run('handleClear()');
  assert.equal(new URLSearchParams(location.search).has('review'), false);
  assert.equal(new URLSearchParams(location.search).get('from'), 'archive');
  assert.equal(location.hash, '#workspace');
  setAddress('/');
  // 6. Leaving a clean workspace is allowed; an unsaved new draft is guarded.
  const beforeUnload = windowEvents.get('beforeunload');
  assert.equal(typeof beforeUnload, 'function');
  const leaving = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    beforeUnload(event); return event;
  };
  assert.equal(leaving().prevented, false);
  // 7. Navigating away cannot silently interrupt an upload, review or save.
  for (const operation of ['activeUpload', 'activeReview', 'activeSave']) {
    run(`${operation} = new AbortController()`);
    assert.equal(leaving().prevented, true, `${operation} must guard navigation`);
    run(`${operation} = null`);
  }
  assert.equal(leaving().prevented, false);
  // 8. Empty workspaces prioritize upload; manual entry remains immediately available.
  assert.equal(ids.get('document-preview').readOnly, false);
  assert.equal(ids.get('document-preview-box').hidden, true);
  ids.get('manual-entry').click();
  assert.equal(ids.get('document-preview-box').hidden, false);
  assert.equal(document.activeElement.id, 'document-preview');
  assert.equal(ids.get('review-document').disabled, true);
  ids.get('document-preview').value = record.normalized_text;
  ids.get('document-preview').events.input();
  assert.equal(leaving().prevented, false);
  assert.equal(leaving().returnValue, undefined);
  assert.equal(ids.get('review-document').disabled, true);
  ids.get('source-select').value = '1'; ids.get('source-select').events.change();
  assert.equal(ids.get('review-document').disabled, false);
  // 9. Adopting a stored record restores text, title, counts and evidence.
  run('adoptRecord(validateDoneEvent(clone(record)))');
  assert.equal(ids.get('decision-summary').textContent.includes('未处理 3'), true);
  assert.equal(ids.get('document-title').value, record.title);
  assert.equal(ids.get('document-preview').value, record.normalized_text);
  assert.equal(run('currentRecord.results[0].evidence[0].source_title'), '测试资料');
  // 10. Adopted records update the address and a refresh restores that record.
  assert.equal(new URLSearchParams(location.search).get('review'), record.review_id);
  assert.equal(leaving().prevented, false);
  const restoreRequests = requests.length;
  await run('initializeWorkspace()');
  assert.equal(requests.slice(restoreRequests).includes(`/api/reviews/${record.review_id}`), true);
  assert.equal(run('currentRecord.review_id'), record.review_id);
  // 11. Human opinions do not overwrite model conclusions.
  ids.get('decision-state-0').value = 'confirmed'; ids.get('decision-state-0').events.change();
  ids.get('decision-note-0').value = '已核对原文，拟修改。'; ids.get('decision-note-0').events.input();
  assert.equal(run('decisionsDirty()'), true);
  assert.equal(ids.get('export-report').disabled, true);
  assert.equal(run('currentRecord.results[0].status'), 'supported');
  assert.equal(run('currentRecord.decisions[0].state'), 'unreviewed');
  // 12. Successfully backed-up opinions may leave without a loss warning.
  assert.equal(leaving().prevented, false);
  // 13. Unsaved opinions prevent clearing the active document.
  run('handleClear()');
  assert.equal(run('currentRecord.review_id'), record.review_id);
  assert.equal(focused.id, 'save-decisions');
  // 14. Editing a document marks existing results stale.
  ids.get('document-preview').value += '\n补充待复核内容。'; ids.get('document-preview').events.input();
  assert.equal(ids.get('stale-result-notice').hidden, false);
  const edited = ids.get('document-preview').value;
  assert.equal(run('currentRecord.normalized_text'), record.normalized_text);
  assert.equal(leaving().prevented, false);
  // 15. Saving opinions retains text being edited and advances the revision.
  await run('saveDecisions()');
  assert.equal(lastBody.expected_revision, 0);
  assert.equal(run('decisionsDirty()'), false);
  assert.equal(ids.get('document-preview').value, edited);
  assert.equal(leaving().prevented, false);
  assert.equal(run('currentRecord.decisions[0].note'), '已核对原文，拟修改。');
  assert.equal(run('currentRecord.decisions_revision'), 1);
  // 16. A save conflict retains local opinions and the current revision.
  ids.get('decision-note-0').value = '冲突时不能丢失的新备注'; ids.get('decision-note-0').events.input();
  saveMode = 'conflict';
  await run('saveDecisions()');
  assert.equal(run('decisionsDirty()'), true);
  assert.equal(run('localDecisions[0].note'), '冲突时不能丢失的新备注');
  assert.match(ids.get('workflow-status').textContent, /其他页面更新/);
  assert.equal(run('currentRecord.decisions_revision'), 1);
  // 17. Discarding opinions restores saved notes, without replacing edited text.
  run('discardDecisions()');
  assert.equal(run('decisionsDirty()'), false);
  assert.equal(run('localDecisions[0].note'), '已核对原文，拟修改。');
  assert.equal(ids.get('document-preview').value, edited);
  // 18. Opening history restores persisted text and human opinions.
  await run(`openHistory('${record.review_id}')`);
  // The reopened record offers its older local copy separately; continue with
  // the saved archive by explicitly choosing the new discard action.
  ids.get('discard-local-draft').click();
  assert.equal(ids.get('document-preview').value, record.normalized_text);
  assert.equal(run('hasDraftChanges()'), false);
  assert.equal(run('localDecisions[0].state'), 'confirmed');
  assert.equal(leaving().prevented, false);
  // 19. Report export uses the displayed revision and downloads once.
  await run('exportReport()');
  assert.equal(lastReportPath, `/api/reviews/${record.review_id}/report?revision=1`);
  assert.equal(reportDownloads, 1);
  assert.equal(downloadLinks.length, 1);
  assert.match(downloadLinks[0].download, /棉袍展签.*审阅报告\.html$/);
  // 20. HTTP 409 during report export never starts another download.
  reportMode = 'conflict';
  await run('exportReport()');
  assert.equal(lastReportPath, `/api/reviews/${record.review_id}/report?revision=1`);
  assert.equal(reportDownloads, 1);
  assert.equal(downloadLinks.length, 1);
  assert.match(ids.get('workflow-status').textContent, /重新打开记录后导出/);
  assert.equal(run('activeReport'), null);
  reportMode = 'ok';
  // 21. Editing opinions while report bytes are pending blocks stale downloads.
  let resolveBlob;
  reportBlob = new Promise(resolve => { resolveBlob = resolve; });
  const editingExport = run('exportReport()');
  await flush();
  ids.get('decision-note-0').value = '导出期间新增的人工意见'; ids.get('decision-note-0').events.input();
  resolveBlob(new Blob(['older report']));
  await editingExport;
  assert.equal(run('decisionsDirty()'), true);
  assert.equal(reportDownloads, 1);
  assert.equal(downloadLinks.length, 1);
  assert.match(ids.get('workflow-status').textContent, /导出期间人工意见发生变化/);
  run('discardDecisions()');
  reportBlob = null;
  // 22. Saving opinions during export blocks the previous revision's download.
  reportBlob = new Promise(resolve => { resolveBlob = resolve; });
  const savingExport = run('exportReport()');
  await flush();
  ids.get('decision-note-0').value = '导出期间保存的新意见'; ids.get('decision-note-0').events.input();
  saveMode = 'ok';
  await run('saveDecisions()');
  assert.equal(run('decisionsDirty()'), false);
  assert.equal(run('currentRecord.decisions_revision'), 2);
  resolveBlob(new Blob(['revision one report']));
  await savingExport;
  assert.equal(lastReportPath, `/api/reviews/${record.review_id}/report?revision=1`);
  assert.equal(reportDownloads, 1);
  assert.equal(downloadLinks.length, 1);
  assert.match(ids.get('workflow-status').textContent, /导出期间人工意见发生变化/);
  reportBlob = null;
  // 23. Rechecking creates a parent-linked version with fresh human opinions.
  ids.get('document-title').value = '棉袍展签修订稿';
  await run('handleReviewClick()');
  assert.equal(lastBody.parent_id, record.review_id);
  assert.equal(lastBody.title, '棉袍展签修订稿');
  run('clearInterval(playTimer); playTimer = null; playQueue = []; finishReview(activeReview)');
  assert.equal(run('currentRecord.review_id'), 'b'.repeat(32));
  assert.equal(run('currentRecord.parent_id'), record.review_id);
  assert.equal(run('currentRecord.decisions[0].state'), 'unreviewed');
  assert.equal(ids.get('document-title').value, '棉袍展签修订稿');
  assert.equal(run('hasDraftChanges()'), false);
  assert.equal(new URLSearchParams(location.search).get('review'), 'b'.repeat(32));
  // 24. Incomplete metadata fails validation without replacing the active record.
  assert.throws(() => run('validateDoneEvent({...clone(record), decisions: []})'), /人工处理/);
  assert.equal(run('currentRecord.review_id'), 'b'.repeat(32));
  const stats = run('currentRecord.stats');
  assert.equal(stats.supported_sentences, 1);
  assert.equal(requests.includes('/api/reviews'), false);
  const prepareLibraryEntry = address => {
    run('handleClear()');
    setAddress(address);
    ids.get('source-select').replaceChildren(new Node('option'));
    run('availableSourceIds = new Set()');
  };
  // 25. A valid library link selects its source without opening an archive.
  prepareLibraryEntry('/?source=1&from=library#workspace');
  const libraryRequests = requests.length;
  await run('initializeWorkspace()');
  assert.deepEqual(requests.slice(libraryRequests).filter(path => path !== '/api/library'), ['/api/sources']);
  assert.equal(ids.get('source-select').value, '1');
  assert.equal(run('currentRecord'), null);
  assert.equal(ids.get('document-preview').value, '');
  assert.match(ids.get('workflow-status').textContent, /已选择资料馆中的资料/);
  assert.equal(ids.get('review-document').disabled, true);
  // 26. Clearing a library entry removes the selection from the address.
  run('handleClear()');
  assert.equal(ids.get('source-select').value, '');
  assert.equal(new URLSearchParams(location.search).has('source'), false);
  assert.equal(new URLSearchParams(location.search).get('from'), 'library');
  assert.equal(location.hash, '#workspace');
  // 27. A missing source never falls back to the first available source.
  prepareLibraryEntry('/?source=999');
  await run('initializeWorkspace()');
  assert.equal(run('availableSourceIds.has(1)'), true);
  assert.equal(ids.get('source-select').value, '');
  assert.equal(ids.get('review-document').disabled, true);
  assert.match(ids.get('workflow-status').textContent, /不存在|不可用|未找到|无法|未收录|暂无可用/);
  assert.equal(ids.get('workflow-notice').className.split(' ').includes('is-error'), true);
  // 28. IDs must be canonical positive safe integers; coercion is forbidden.
  for (const source of ['', '0', '-1', '1.0', '01', '+1', '1e0', ' 1 ', '9007199254740992']) {
    prepareLibraryEntry(`/?source=${encodeURIComponent(source)}`);
    await run('initializeWorkspace()');
    assert.equal(ids.get('source-select').value, '', `invalid source ${JSON.stringify(source)} must stay unselected`);
    assert.equal(ids.get('review-document').disabled, true);
    assert.match(ids.get('workflow-status').textContent, /无效|不正确|不合法|格式/);
    assert.equal(ids.get('workflow-notice').className.split(' ').includes('is-error'), true);
  }
  // 29. A record link takes precedence over a conflicting or invalid source.
  for (const source of ['999', 'not-an-id']) {
    prepareLibraryEntry(`/?review=${record.review_id}&source=${source}`);
    await run('initializeWorkspace()');
    assert.equal(run('currentRecord.review_id'), record.review_id);
    assert.equal(ids.get('source-select').value, '1');
    assert.equal(run('hasDraftChanges()'), false);
    assert.equal(new URLSearchParams(location.search).has('source'), false);
  }
  // 30. A slow source request locks editing until the linked source is applied.
  prepareLibraryEntry('/?source=1');
  sourcesResponse = new Promise(resolve => { resolveSources = resolve; });
  const libraryStartup = run('initializeWorkspace()');
  await flush();
  assert.equal(run('Boolean(activeSourceSelection)'), true);
  for (const id of ['source-select', 'document-title', 'document-file', 'clear-button', 'review-document']) {
    assert.equal(ids.get(id).disabled, true, `${id} must stay locked during source selection`);
  }
  assert.equal(ids.get('document-preview').readOnly, true);
  run('handleClear()');
  assert.equal(new URLSearchParams(location.search).get('source'), '1');
  resolveSources(response(sourcesData));
  await libraryStartup;
  sourcesResponse = null;
  assert.equal(run('Boolean(activeSourceSelection)'), false);
  assert.equal(ids.get('source-select').value, '1');
  for (const id of ['source-select', 'document-title', 'document-file', 'clear-button']) {
    assert.equal(ids.get(id).disabled, false, `${id} must unlock after source selection`);
  }
  assert.equal(ids.get('document-preview').readOnly, false);
  // 31. Failed source loading also releases controls without choosing a source.
  prepareLibraryEntry('/?source=1');
  sourcesResponse = new Promise(resolve => { resolveSources = resolve; });
  const failedLibraryStartup = run('initializeWorkspace()');
  await flush();
  assert.equal(ids.get('document-preview').readOnly, true);
  resolveSources(response({ error: '资料服务暂时不可用，请重试。' }, 503));
  await failedLibraryStartup;
  sourcesResponse = null;
  assert.equal(run('Boolean(activeSourceSelection)'), false);
  assert.equal(ids.get('source-select').value, '');
  assert.equal(ids.get('review-document').disabled, true);
  assert.equal(ids.get('document-preview').readOnly, false);
  assert.equal(ids.get('document-title').disabled, false);
  assert.equal(ids.get('document-file').disabled, false);
  assert.equal(ids.get('clear-button').disabled, false);
  assert.equal(ids.get('workflow-notice').className.split(' ').includes('is-error'), true);
  // 32. Completing a library-started review replaces source with its record ID.
  prepareLibraryEntry('/?source=1&from=library#workspace');
  await run('initializeWorkspace()');
  ids.get('document-title').value = '从资料馆开始的审阅';
  ids.get('document-preview').value = record.normalized_text;
  ids.get('document-preview').events.input();
  await run('handleReviewClick()');
  assert.equal(lastBody.source_id, 1);
  assert.equal(lastBody.parent_id, undefined);
  run('clearInterval(playTimer); playTimer = null; playQueue = []; finishReview(activeReview)');
  assert.equal(run('currentRecord.review_id'), 'b'.repeat(32));
  assert.equal(new URLSearchParams(location.search).has('source'), false);
  assert.equal(new URLSearchParams(location.search).get('review'), 'b'.repeat(32));
  assert.equal(new URLSearchParams(location.search).get('from'), 'library');
  assert.equal(location.hash, '#workspace');
  assert.equal(requests.includes('/api/reviews'), false);
  const sentenceRecord = clone(record);
  const unicodeSentences = [`🧵${sentences[0]}`, sentences[1], sentences[2]];
  sentenceRecord.review_id = 'c'.repeat(32);
  sentenceRecord.normalized_text = unicodeSentences.join('\n');
  let sentenceOffset = 0;
  sentenceRecord.results.forEach((result, index) => {
    result.sentence = unicodeSentences[index];
    result.sentence_start = sentenceOffset;
    sentenceOffset += Array.from(result.sentence).length;
    result.sentence_end = sentenceOffset;
    sentenceOffset += 1;
  });
  context.sentenceRecord = sentenceRecord;
  const sentenceEditor = ids.get('sentence-editor');
  const documentEditor = ids.get('document-preview');
  const editSentence = value => { sentenceEditor.value = value; sentenceEditor.events.input(); };
  const highlight = () => ids.get('sentence-context').children.find(node => node.tagName === 'mark');
  const savedSentenceRecord = JSON.stringify(sentenceRecord);
  // 33. Result navigation selects the right UTF-16 range after an emoji.
  run('adoptRecord(validateDoneEvent(clone(sentenceRecord)))');
  ids.get('locate-sentence-1').click();
  assert.equal(run('activeSentenceIndex'), 1);
  assert.equal(ids.get('sentence-focus').hidden, false);
  assert.equal(ids.get('preview-tab').getAttribute('aria-selected'), 'true');
  assert.equal(documentEditor.selectionStart, unicodeSentences[0].length + 1);
  assert.equal(documentEditor.selectionEnd, unicodeSentences[0].length + 1 + unicodeSentences[1].length);
  assert.equal(highlight().textContent, unicodeSentences[1]);
  assert.equal(sentenceEditor.value, unicodeSentences[1]);
  assert.match(ids.get('sentence-original').textContent, /主人喜欢音乐/);
  assert.equal(ids.get('sentence-evidence').children.length > 1, true);
  assert.equal(focused.id, 'sentence-focus-title');
  // 34. Pending local input blocks destructive navigation, import and recheck.
  const pendingSentence = '这件棉袍的主人喜好尚待补证。';
  editSentence(pendingSentence);
  assert.equal(run('hasSentenceEdit()'), true);
  assert.equal(documentEditor.value, sentenceRecord.normalized_text);
  assert.equal(documentEditor.readOnly, true);
  assert.equal(ids.get('review-document').disabled, true);
  assert.equal(leaving().prevented, false);
  const pendingRequests = requests.length;
  run('locateSentence(2)');
  assert.equal(run('activeSentenceIndex'), 1);
  run('handleClear()');
  await run(`openHistory('${record.review_id}')`);
  await run('handleReviewClick()');
  ids.get('document-file').files = [{ name: 'replacement.docx', size: 32 }];
  await run('handleDocumentChange()');
  ids.get('document-file').files = [];
  ids.get('restore-draft').click();
  assert.equal(requests.length, pendingRequests);
  assert.equal(run('currentRecord.review_id'), sentenceRecord.review_id);
  assert.equal(sentenceEditor.value, pendingSentence);
  assert.equal(documentEditor.value, sentenceRecord.normalized_text);
  assert.match(ids.get('workflow-status').textContent, /未应用/);
  assert.equal(focused.id, 'sentence-editor');
  // 35. Tab/result navigation preserves input and reveals a filtered-out card.
  ids.get('results-tab').click();
  ids.get('locate-sentence-1').click();
  assert.equal(sentenceEditor.value, pendingSentence);
  const currentFilters = ids.get('review-result').children.find(node => node.className === 'result-filters');
  currentFilters.children.find(node => node.dataset.status === 'supported').click();
  assert.equal(ids.get('sentence-result-1').hidden, true);
  ids.get('return-to-result').click();
  assert.equal(ids.get('results-tab').getAttribute('aria-selected'), 'true');
  assert.equal(ids.get('sentence-result-1').hidden, false);
  assert.equal(ids.get('result-filter-all').getAttribute('aria-pressed'), 'true');
  assert.equal(focused.id, 'sentence-result-1');
  assert.equal(Boolean(ids.get('sentence-result-1').lastScrollIntoView), true);
  assert.equal(sentenceEditor.value, pendingSentence);
  // 36. Cancelling unapplied input restores the current sentence and unlocks.
  ids.get('cancel-sentence-edit').click();
  assert.equal(run('hasSentenceEdit()'), false);
  assert.equal(sentenceEditor.value, unicodeSentences[1]);
  assert.equal(documentEditor.value, sentenceRecord.normalized_text);
  assert.equal(documentEditor.readOnly, false);
  assert.equal(ids.get('review-document').disabled, false);
  assert.equal(leaving().prevented, false);
  // 37. Applying edits only the draft; model and human conclusions stay intact.
  ids.get('decision-state-0').value = 'confirmed'; ids.get('decision-state-0').events.change();
  ids.get('decision-note-0').value = '人工意见在改稿后仍保留。'; ids.get('decision-note-0').events.input();
  const pendingDecisions = run('JSON.stringify(localDecisions)');
  editSentence(pendingSentence);
  ids.get('apply-sentence-edit').click();
  assert.equal(documentEditor.value, [unicodeSentences[0], pendingSentence, unicodeSentences[2]].join('\n'));
  assert.equal(run('JSON.stringify(currentRecord)'), savedSentenceRecord);
  assert.equal(run('JSON.stringify(localDecisions)'), pendingDecisions);
  assert.equal(run('hasSentenceEdit()'), false);
  assert.equal(ids.get('stale-result-notice').hidden, false);
  assert.equal(ids.get('sentence-edit-state-1').dataset.state, 'modified');
  assert.equal(run('window.SentenceMap.locate(currentSentenceMap, 1).status'), 'edited');
  assert.equal(sentenceEditor.readOnly, false);
  assert.equal(sentenceEditor.value, pendingSentence);
  assert.equal(ids.get('apply-sentence-edit').disabled, true);
  // 38. A nonempty replacement remains editable and shifts later locations.
  const revisedSentence = '🧭这件棉袍的主人喜好没有资料记载。';
  editSentence(revisedSentence);
  ids.get('apply-sentence-edit').click();
  assert.equal(documentEditor.value, [unicodeSentences[0], revisedSentence, unicodeSentences[2]].join('\n'));
  ids.get('locate-sentence-2').click();
  assert.equal(documentEditor.selectionStart, unicodeSentences[0].length + revisedSentence.length + 2);
  assert.equal(documentEditor.selectionEnd, documentEditor.value.length);
  assert.equal(sentenceEditor.value, unicodeSentences[2]);
  assert.equal(highlight().textContent, unicodeSentences[2]);
  ids.get('locate-sentence-1').click();
  assert.equal(sentenceEditor.value, revisedSentence);
  assert.equal(run('JSON.stringify(currentRecord)'), savedSentenceRecord);
  // 39. Direct full-text insertion updates later sentence selection/context.
  run('discardDecisions()');
  ids.get('restore-draft').click();
  assert.equal(ids.get('sentence-focus').hidden, true);
  const introduction = '新增引言。\n';
  documentEditor.setSelectionRange(0, 0);
  documentEditor.events.beforeinput();
  documentEditor.value = introduction + sentenceRecord.normalized_text;
  documentEditor.events.input();
  ids.get('locate-sentence-1').click();
  assert.equal(documentEditor.selectionStart, introduction.length + unicodeSentences[0].length + 1);
  assert.equal(highlight().textContent, unicodeSentences[1]);
  assert.equal(sentenceEditor.value, unicodeSentences[1]);
  assert.equal(run('JSON.stringify(currentRecord)'), savedSentenceRecord);
  // 40. Replacing the whole draft invalidates old ranges instead of guessing.
  documentEditor.value = '完全不同的新稿。';
  documentEditor.events.input();
  ids.get('locate-sentence-1').click();
  assert.equal(run('window.SentenceMap.locate(currentSentenceMap, 1)'), null);
  assert.equal(sentenceEditor.readOnly, true);
  assert.equal(ids.get('apply-sentence-edit').disabled, true);
  assert.match(ids.get('sentence-focus-message').textContent, /无法可靠定位/);
  assert.match(ids.get('sentence-original').textContent, /主人喜欢音乐/);
  editSentence('不应错误替换到新稿。');
  run('applySentenceEdit()');
  assert.equal(documentEditor.value, '完全不同的新稿。');
  run('cancelSentenceEdit()');
  ids.get('restore-draft').click();
  // 41. Unexpected full-text changes during pending input reject its apply.
  ids.get('locate-sentence-1').click();
  editSentence(pendingSentence);
  documentEditor.value = introduction + sentenceRecord.normalized_text;
  documentEditor.events.input();
  assert.equal(run('sentenceEditConflict'), true);
  assert.equal(sentenceEditor.value, pendingSentence);
  assert.equal(ids.get('apply-sentence-edit').disabled, true);
  run('applySentenceEdit()');
  assert.equal(documentEditor.value, introduction + sentenceRecord.normalized_text);
  assert.match(ids.get('sentence-focus-message').textContent, /正文已在输入期间变化/);
  ids.get('cancel-sentence-edit').click();
  assert.equal(run('sentenceEditConflict'), false);
  assert.equal(sentenceEditor.value, unicodeSentences[1]);
  assert.equal(run('hasSentenceEdit()'), false);
  // 42. Deleting a sentence invalidates only its range and preserves neighbors.
  ids.get('restore-draft').click();
  ids.get('locate-sentence-1').click();
  editSentence('');
  ids.get('apply-sentence-edit').click();
  assert.equal(documentEditor.value, [unicodeSentences[0], '', unicodeSentences[2]].join('\n'));
  assert.equal(run('window.SentenceMap.locate(currentSentenceMap, 1)'), null);
  assert.equal(sentenceEditor.readOnly, true);
  assert.equal(ids.get('sentence-edit-state-1').dataset.state, 'unavailable');
  ids.get('locate-sentence-2').click();
  assert.equal(sentenceEditor.value, unicodeSentences[2]);
  assert.equal(documentEditor.selectionStart, unicodeSentences[0].length + 2);
  assert.equal(run('JSON.stringify(currentRecord)'), savedSentenceRecord);
  // 43. Restore, clear and opening another record reset the sentence panel.
  ids.get('restore-draft').click();
  assert.equal(run('activeSentenceIndex'), null);
  assert.equal(ids.get('sentence-focus').hidden, true);
  assert.equal(documentEditor.value, sentenceRecord.normalized_text);
  ids.get('locate-sentence-0').click();
  run('handleClear()');
  assert.equal(run('currentRecord'), null);
  assert.equal(run('currentSentenceMap'), null);
  assert.equal(run('activeSentenceIndex'), null);
  assert.equal(ids.get('sentence-focus').hidden, true);
  run('adoptRecord(validateDoneEvent(clone(sentenceRecord)))');
  assert.equal(ids.get('sentence-focus').hidden, true);
  assert.equal(run('hasSentenceEdit()'), false);
  assert.equal(leaving().prevented, false);
  // 44. Oversized local replacements keep their input without changing text.
  ids.get('locate-sentence-1').click();
  editSentence('字'.repeat(50000));
  ids.get('apply-sentence-edit').click();
  assert.equal(documentEditor.value, sentenceRecord.normalized_text);
  assert.equal(sentenceEditor.value.length, 50000);
  assert.equal(run('hasSentenceEdit()'), true);
  assert.match(ids.get('sentence-focus-message').textContent, /50,000/);
  ids.get('cancel-sentence-edit').click();
  assert.equal(run('hasSentenceEdit()'), false);
  // 45. Five-state grouping changes presentation only, preserving sentence IDs.
  const groupedRecord = clone(record);
  const mixedStatuses = ['supported', 'uncovered', 'refute', 'insufficient', 'conflicting', 'refute', 'supported', 'insufficient'];
  const groupOrder = ['refute', 'conflicting', 'insufficient', 'supported', 'uncovered'];
  let groupedOffset = 0;
  groupedRecord.results = mixedStatuses.map((status, index) => {
    const result = clone(record.results[0]);
    result.index = index;
    result.sentence = `第${index + 1}件服饰采用对襟设计。`;
    result.sentence_start = groupedOffset;
    groupedOffset += Array.from(result.sentence).length;
    result.sentence_end = groupedOffset;
    groupedOffset += 1;
    result.status = status;
    result.reason = status === 'uncovered' ? 'no_evidence' : 'fixture_grouping';
    result.message = {
      supported: '模型判为支持，请核对适用范围。', refute: '模型判为反驳，请核对原文。',
      insufficient: '现有证据不足以支持或反驳。', conflicting: '部分证据判为支持，另有证据判为反驳。',
      uncovered: '未检索到可比对证据。',
    }[status];
    const stances = { supported: ['supports', 'insufficient'], refute: ['refutes', 'insufficient'], insufficient: ['insufficient'], conflicting: ['supports', 'refutes'], uncovered: [] }[status];
    result.evidence = stances.map((stance, position) => ({
      ...clone(record.results[0].evidence[0]), evidence_id: index * 2 + position + 1, stance,
      evidence: `第 ${index + 1} 句的第 ${position + 1} 条资料原文。`,
      scores: { supports: stance === 'supports' ? 0.9 : 0.05, refutes: stance === 'refutes' ? 0.9 : 0.05, insufficient: stance === 'insufficient' ? 0.9 : 0.05 },
    }));
    return result;
  });
  groupedRecord.review_id = 'd'.repeat(32);
  groupedRecord.normalized_text = groupedRecord.results.map(result => result.sentence).join('\n');
  groupedRecord.decisions = groupedRecord.results.map(result => ({ index: result.index, state: 'unreviewed', note: '' }));
  groupedRecord.stats = {
    total_sentences: 8, checked_sentences: 7, problems_found: 2,
    supported_sentences: 2, refuted_sentences: 2, insufficient_sentences: 2,
    conflicting_sentences: 1, uncovered_sentences: 1, no_evidence_sentences: 1,
    low_relevance_sentences: 0, noise_sentences: 0, coverage_ratio: 7 / 8,
  };
  context.groupedRecord = groupedRecord;
  const originalGroupedResults = JSON.stringify(groupedRecord.results);
  run('adoptRecord(validateDoneEvent(clone(groupedRecord)))');
  const descendants = node => (node.children || []).flatMap(child => [child, ...descendants(child)]);
  const groups = descendants(ids.get('review-result')).filter(node => node.className?.split(' ').includes('result-group'));
  assert.deepEqual(groups.map(group => group.dataset.status), groupOrder);
  for (const group of groups) {
    const status = group.dataset.status;
    assert.equal(group.id, `result-group-${status}`);
    const list = group.children.find(node => node.className?.split(' ').includes('result-group-list'));
    assert.ok(list, `group ${status} must contain its sentence list`);
    assert.deepEqual(list.children.map(card => card.id), groupedRecord.results.filter(result => result.status === status).map(result => `sentence-result-${result.index}`));
  }
  assert.equal(run('JSON.stringify(currentRecord.results)'), originalGroupedResults);
  // 46. Filtering, return navigation and saved decisions retain original indexes.
  const groupingFilters = ids.get('review-result').children.find(node => node.className === 'result-filters');
  for (const status of groupOrder) {
    groupingFilters.children.find(button => button.dataset.status === status).click();
    for (const group of groups) assert.equal(group.hidden, group.dataset.status !== status);
    groupedRecord.results.forEach(result => assert.equal(ids.get(`sentence-result-${result.index}`).hidden, result.status !== status));
  }
  ids.get('result-filter-all').click();
  ids.get('locate-sentence-5').click();
  assert.equal(run('activeSentenceIndex'), 5);
  assert.equal(sentenceEditor.value, groupedRecord.results[5].sentence);
  assert.equal(documentEditor.selectionStart, groupedRecord.results[5].sentence_start);
  assert.equal(documentEditor.selectionEnd, groupedRecord.results[5].sentence_end);
  groupingFilters.children.find(button => button.dataset.status === 'supported').click();
  assert.equal(ids.get('result-group-refute').hidden, true);
  assert.equal(ids.get('sentence-result-5').hidden, true);
  ids.get('return-to-result').click();
  assert.equal(ids.get('result-group-refute').hidden, false);
  assert.equal(ids.get('sentence-result-5').hidden, false);
  assert.equal(focused.id, 'sentence-result-5');
  assert.equal(ids.get('result-filter-all').getAttribute('aria-pressed'), 'true');
  ids.get('decision-state-5').value = 'confirmed'; ids.get('decision-state-5').events.change();
  ids.get('decision-note-5').value = '只属于原文第六句的处理意见。'; ids.get('decision-note-5').events.input();
  decisionRecord = groupedRecord;
  saveMode = 'ok';
  await run('saveDecisions()');
  assert.equal(lastBody.decisions[5].index, 5);
  assert.equal(lastBody.decisions[5].note, '只属于原文第六句的处理意见。');
  assert.equal(run('currentRecord.decisions[5].state'), 'confirmed');
  assert.equal(run('currentRecord.decisions[5].note'), '只属于原文第六句的处理意见。');
  for (const decision of lastBody.decisions.filter(item => item.index !== 5)) {
    assert.equal(decision.state, 'unreviewed');
    assert.equal(decision.note, '');
  }
  assert.equal(run('JSON.stringify(currentRecord.results)'), originalGroupedResults);
  assert.equal(run('decisionsDirty()'), false);
  // 47. Selective list excerpts leave full evidence and uncertainty accessible.
  for (const result of groupedRecord.results) {
    const nodes = descendants(ids.get(`sentence-result-${result.index}`));
    const evidenceDetails = nodes.filter(node => node.className === 'evidence-details');
    const quotes = nodes.filter(node => node.tagName === 'blockquote');
    assert.equal(nodes.find(node => node.className === 'result-message').textContent, result.message);
    if (['refute', 'supported'].includes(result.status)) {
      assert.equal(evidenceDetails.length, 1);
      assert.equal(evidenceDetails[0].open, true);
      // Retain every excerpt, including any insufficient evidence for this sentence.
      assert.deepEqual(quotes.map(node => node.textContent), result.evidence.map(item => item.evidence));
    } else {
      assert.equal(evidenceDetails.length, 0);
      assert.equal(quotes.length, 0);
      if (result.status !== 'uncovered') {
        assert.equal(nodes.some(node => node.className === 'no-evidence-note'), false);
      }
    }
  }
  ids.get('locate-sentence-4').click();
  assert.equal(run('activeSentenceIndex'), 4);
  const conflictingReference = descendants(ids.get('sentence-evidence'));
  assert.match(conflictingReference.find(node => node.className === 'result-message').textContent, /判定分歧.*部分证据判为支持，另有证据判为反驳/);
  assert.deepEqual(conflictingReference.filter(node => node.tagName === 'blockquote').map(node => node.textContent), groupedRecord.results[4].evidence.map(item => item.evidence));
  assert.equal(run('JSON.stringify(currentRecord.results)'), originalGroupedResults);
  // 48. Every sentence has an adjacent save action and a truthful dirty state.
  run('adoptRecord(validateDoneEvent(clone(groupedRecord)))');
  decisionRecord = groupedRecord;
  const editDecision = (index, state, note) => {
    ids.get(`decision-state-${index}`).value = state;
    ids.get(`decision-state-${index}`).events.change();
    ids.get(`decision-note-${index}`).value = note;
    ids.get(`decision-note-${index}`).events.input();
  };
  const inlineState = index => ids.get(`decision-save-status-${index}`).dataset.state;
  for (const result of groupedRecord.results) {
    const card = ids.get(`sentence-result-${result.index}`);
    const nodes = descendants(card);
    const button = ids.get(`save-decision-${result.index}`);
    const status = ids.get(`decision-save-status-${result.index}`);
    assert.ok(nodes.includes(button), 'save action must be beside its sentence fields');
    assert.ok(nodes.includes(status), 'save feedback must be beside its sentence fields');
    assert.equal(typeof button.events.click, 'function');
    assert.equal(button.disabled, true);
    assert.equal(inlineState(result.index), 'unchanged');
  }
  editDecision(0, 'confirmed', '第一句的独立意见。');
  assert.equal(inlineState(0), 'dirty');
  assert.equal(ids.get('save-decision-0').disabled, false);
  editDecision(0, 'unreviewed', '');
  assert.equal(inlineState(0), 'unchanged');
  assert.equal(ids.get('save-decision-0').disabled, true);
  assert.equal(run('decisionsDirty()'), false);
  // 49. Saving one sentence does not accidentally save another edited sentence.
  editDecision(0, 'confirmed', '只保存第一句。');
  editDecision(3, 'pending', '第四句暂不保存。');
  await ids.get('save-decision-0').click();
  await flush();
  assert.deepEqual(lastBody.decisions[0], { index: 0, state: 'confirmed', note: '只保存第一句。' });
  assert.deepEqual(lastBody.decisions[3], { index: 3, state: 'unreviewed', note: '' });
  assert.equal(run('currentRecord.decisions[0].note'), '只保存第一句。');
  assert.equal(run('currentRecord.decisions[3].note'), '');
  assert.equal(run('localDecisions[3].note'), '第四句暂不保存。');
  assert.equal(ids.get('decision-note-3').value, '第四句暂不保存。');
  assert.equal(inlineState(0), 'saved');
  assert.equal(inlineState(3), 'dirty');
  assert.match(ids.get('decision-save-status-1').textContent, /尚未人工处理/);
  assert.equal(ids.get('save-decision-0').disabled, true);
  assert.equal(ids.get('save-decision-3').disabled, false);
  assert.equal(ids.get('export-report').disabled, true);
  assert.equal(run('decisionsDirty()'), true);
  assert.equal(run('JSON.stringify(currentRecord.results)'), originalGroupedResults);
  // 50. The top action still saves all outstanding decisions in one revision.
  editDecision(6, 'dismissed', '第七句一并保存。');
  const beforeBatchRevision = run('currentRecord.decisions_revision');
  await ids.get('save-decisions').click();
  await flush();
  assert.equal(lastBody.expected_revision, beforeBatchRevision);
  assert.equal(lastBody.decisions[0].note, '只保存第一句。');
  assert.equal(lastBody.decisions[3].note, '第四句暂不保存。');
  assert.equal(lastBody.decisions[6].note, '第七句一并保存。');
  assert.equal(run('currentRecord.decisions_revision'), beforeBatchRevision + 1);
  assert.equal(run('decisionsDirty()'), false);
  assert.equal(inlineState(3), 'saved');
  assert.equal(inlineState(6), 'saved');
  assert.equal(ids.get('export-report').disabled, false);
  editDecision(3, 'pending', '临时更改。');
  assert.equal(inlineState(3), 'dirty');
  editDecision(3, 'pending', '第四句暂不保存。');
  assert.ok(['saved', 'unchanged'].includes(inlineState(3)));
  assert.equal(ids.get('save-decision-3').disabled, true);
  // 51. Pending saves show local progress and prevent duplicate/conflicting edits.
  editDecision(1, 'pending', '正在保存第二句。');
  editDecision(2, 'confirmed', '第三句仍保持未保存。');
  let resolveDecisionSave;
  saveResponse = new Promise(resolve => { resolveDecisionSave = resolve; });
  const pendingSave = run('saveDecisions(1)');
  await flush();
  assert.equal(inlineState(1), 'saving');
  assert.equal(inlineState(2), 'dirty');
  for (const index of [1, 2]) {
    assert.equal(ids.get(`save-decision-${index}`).disabled, true);
    assert.equal(ids.get(`decision-state-${index}`).disabled, true);
    assert.equal(ids.get(`decision-note-${index}`).disabled, true);
  }
  assert.equal(ids.get('save-decisions').disabled, true);
  assert.equal(leaving().prevented, true);
  const pendingRequestCount = requests.length;
  await run('saveDecisions(2)');
  assert.equal(requests.length, pendingRequestCount);
  resolveDecisionSave(response({ ...clone(decisionRecord), decisions_revision: lastBody.expected_revision + 1, decisions: clone(lastBody.decisions) }));
  await pendingSave;
  saveResponse = null;
  assert.equal(inlineState(1), 'saved');
  assert.equal(inlineState(2), 'dirty');
  assert.equal(ids.get('save-decision-2').disabled, false);
  assert.equal(ids.get('decision-note-2').disabled, false);
  assert.equal(run('currentRecord.decisions[2].note'), '');
  // 52. Errors and revision conflicts remain visible locally without losing input.
  const beforeErrorRecord = run('JSON.stringify(currentRecord)');
  saveResponse = response({ error: '保存服务暂时不可用，请重试。' }, 503);
  await run('saveDecisions(2)');
  saveResponse = null;
  assert.equal(inlineState(2), 'error');
  assert.match(ids.get('decision-save-status-2').textContent, /保存服务暂时不可用/);
  assert.equal(ids.get('save-decision-2').disabled, false);
  assert.equal(ids.get('decision-note-2').value, '第三句仍保持未保存。');
  assert.equal(run('localDecisions[2].note'), '第三句仍保持未保存。');
  assert.equal(run('JSON.stringify(currentRecord)'), beforeErrorRecord);
  await run('saveDecisions(2)');
  assert.equal(inlineState(2), 'saved');
  assert.equal(run('decisionsDirty()'), false);
  editDecision(4, 'pending', '分歧句等待进一步核对。');
  const beforeConflictRecord = run('JSON.stringify(currentRecord)');
  saveMode = 'conflict';
  await run('saveDecisions(4)');
  assert.equal(inlineState(4), 'error');
  assert.match(ids.get('decision-save-status-4').textContent, /其他页面更新/);
  assert.equal(run('JSON.stringify(currentRecord)'), beforeConflictRecord);
  assert.equal(ids.get('decision-note-4').value, '分歧句等待进一步核对。');
  assert.equal(run('localDecisions[4].note'), '分歧句等待进一步核对。');
  // 53. Discarding or switching records clears stale local save feedback.
  run('discardDecisions()');
  assert.equal(run('decisionSaveError'), null);
  assert.equal(run('activeDecisionSaveIndexes.size'), 0);
  assert.ok(['saved', 'unchanged'].includes(inlineState(4)));
  assert.equal(ids.get('decision-note-4').value, '');
  editDecision(4, 'pending', '切换记录前的失败意见。');
  await run('saveDecisions(4)');
  assert.equal(inlineState(4), 'error');
  run('adoptRecord(validateDoneEvent(clone(record)))');
  assert.equal(run('decisionSaveError'), null);
  assert.equal(run('activeDecisionSaveIndexes.size'), 0);
  assert.equal(inlineState(0), 'unchanged');
  assert.equal(run('decisionsDirty()'), false);
  saveMode = 'ok';
  run('handleClear()');
  assert.equal(run('currentRecord'), null);
  assert.equal(run('decisionSaveError'), null);
  assert.equal(run('activeDecisionSaveIndexes.size'), 0);
  console.log('PASS: 53 frontend workflow scenarios, including per-sentence save isolation/progress/errors, selective list evidence, status grouping/index integrity, sentence editing, Unicode selection, library entry, archive recovery and report revision races');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { timers.forEach(clearTimer); });

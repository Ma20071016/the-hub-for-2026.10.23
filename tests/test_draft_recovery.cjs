/* Integration regressions for browser-local draft recovery.
 * Run: node tests/test_draft_recovery.cjs
 * Uses the real frontend scripts and in-memory DOM/HTTP/Storage only.
 */
const assert = require('node:assert/strict');
const harnessPath = require.resolve('./test_workflow_frontend.cjs');
const NEW_KEY = 'cmit:workspace-draft:v1:new';
const reviewKey = id => `cmit:workspace-draft:v1:review:${id}`;
const activeHarnesses = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fresh(entries = [], address = '/') {
  delete require.cache[harnessPath];
  const h = require(harnessPath);
  activeHarnesses.add(h);
  for (const [key, value] of entries) h.storageData.set(key, value);
  await h.flush();
  if (address !== '/') {
    h.setAddress(address);
    await h.run('initializeWorkspace()');
  }
  return h;
}

function input(h, id, value, event = 'input') {
  const node = h.ids.get(id);
  node.value = value;
  node.events[event]({});
}

function fillNew(h, text = '棉袍采用对襟设计。', title = '待完成展签') {
  input(h, 'document-title', title);
  input(h, 'document-preview', text);
  input(h, 'source-select', '1', 'change');
}

function stored(h, key = NEW_KEY) {
  const value = h.storageData.get(key);
  return value ? JSON.parse(value) : null;
}

function save(h) {
  assert.equal(h.run('flushDraftSave()'), true);
}

async function openRecord(h) {
  h.setAddress(`/?review=${h.record.review_id}`);
  await h.run('initializeWorkspace()');
  assert.equal(h.run('currentRecord.review_id'), h.record.review_id);
}

function editOpinion(h, index, state, note) {
  input(h, `decision-state-${index}`, state, 'change');
  input(h, `decision-note-${index}`, note);
}

async function seedReviewDraft(h, overrides = {}) {
  await openRecord(h);
  const draft = { ...JSON.parse(h.run('JSON.stringify(captureLocalDraft())')), ...overrides };
  const key = reviewKey(h.record.review_id);
  h.storageData.set(key, JSON.stringify(draft));
  h.run('initializeDrafts()');
  assert.equal(h.run('draftStore.read(currentRecord.review_id).ok'), true);
  return draft;
}

const cases = [
  ['typing is debounced and persisted without creating an archive record', async () => {
    const h = await fresh();
    fillNew(h);
    assert.equal(h.storageData.has(NEW_KEY), false);
    assert.equal(h.ids.get('local-draft-status').dataset.state, 'saving');
    await pause(550);
    assert.equal(stored(h).text, '棉袍采用对襟设计。');
    assert.equal(stored(h).title, '待完成展签');
    assert.equal(stored(h).source_id, 1);
    assert.equal(h.run('isLocalDraftSaved()'), true);
    assert.match(h.ids.get('local-draft-status').textContent, /已暂存到本机/);
    assert.deepEqual(h.requests, ['/api/sources', '/api/library']);
  }],
  ['refresh offers an explicit restore and does not overwrite pending work', async () => {
    const first = await fresh();
    fillNew(first, '上次尚未完成的正文。'); save(first);
    const raw = first.storageData.get(NEW_KEY);
    const h = await fresh(first.storageData);
    assert.equal(h.ids.get('document-preview').value, '');
    assert.equal(h.ids.get('local-draft-recovery').hidden, false);
    input(h, 'document-preview', '这次刚刚输入的新正文。');
    assert.equal(h.run('flushDraftSave()'), false);
    assert.equal(h.storageData.get(NEW_KEY), raw);
    assert.equal(h.run('isLocalDraftSaved()'), false);
    assert.equal(h.run('recoverLocalDraft()'), true);
    assert.equal(h.ids.get('document-preview').value, '上次尚未完成的正文。');
    assert.equal(h.ids.get('document-title').value, '待完成展签');
    assert.equal(h.ids.get('source-select').value, '1');
    assert.equal(h.ids.get('local-draft-recovery').hidden, true);
    assert.deepEqual(h.requests, ['/api/sources', '/api/library']);
  }],
  ['a library link keeps its source until the user explicitly restores', async () => {
    const first = await fresh(); fillNew(first); save(first);
    const h = await fresh(first.storageData);
    h.sourcesData.sources.push({ id: 2, title: '资料二', object_name: '另一藏品' });
    h.setAddress('/?source=2'); await h.run('initializeWorkspace()');
    assert.equal(h.ids.get('source-select').value, '2');
    assert.match(h.ids.get('local-draft-detail').textContent, /资料 #1/);
    assert.equal(h.run('recoverLocalDraft()'), true);
    assert.equal(h.ids.get('source-select').value, '1');
  }],
  ['new-document drafts and individual archive drafts are isolated', async () => {
    const h = await fresh(); fillNew(h, '新稿应单独保存。'); save(h);
    const newRaw = h.storageData.get(NEW_KEY);
    await openRecord(h);
    assert.equal(h.run('draftSession.pending'), null);
    input(h, 'document-preview', `${h.record.normalized_text}\n档案文稿的修改。`); save(h);
    const key = reviewKey(h.record.review_id);
    assert.equal(h.storageData.get(NEW_KEY), newRaw);
    assert.match(stored(h, key).text, /档案文稿的修改/);
    const linked = await fresh(h.storageData, `/?review=${h.record.review_id}`);
    assert.equal(linked.run('draftSession.pending.review_id'), h.record.review_id);
    assert.equal(linked.ids.get('document-preview').value, h.record.normalized_text);
    assert.equal(linked.run('recoverLocalDraft()'), true);
    assert.match(linked.ids.get('document-preview').value, /档案文稿的修改/);
    assert.equal(linked.storageData.get(NEW_KEY), newRaw);
  }],
  ['unavailable archive loading never offers an unrelated new draft', async () => {
    const h = await fresh(); fillNew(h); save(h);
    h.historyUnavailable = true;
    h.setAddress(`/?review=${h.record.review_id}`);
    await h.run('initializeWorkspace()');
    assert.equal(h.run('currentRecord'), null);
    assert.equal(h.run('draftSession'), null);
    assert.equal(h.ids.get('local-draft-recovery').hidden, true);
    assert.equal(h.storageData.has(NEW_KEY), true);
  }],
  ['archive recovery retains unapplied sentence input outside the document', async () => {
    const h = await fresh(); await openRecord(h);
    editOpinion(h, 0, 'pending', '需要补充藏品来源。');
    h.run('locateSentence(0)');
    input(h, 'sentence-editor', '这里是尚未应用的单句修改。');
    save(h);
    const key = reviewKey(h.record.review_id);
    assert.equal(stored(h, key).text, h.record.normalized_text);
    assert.equal(stored(h, key).sentence_edit.text, '这里是尚未应用的单句修改。');
    const restored = await fresh(h.storageData, `/?review=${h.record.review_id}`);
    assert.equal(restored.run('recoverLocalDraft()'), true);
    assert.equal(restored.ids.get('document-preview').value, h.record.normalized_text);
    assert.equal(restored.ids.get('sentence-editor').value, '这里是尚未应用的单句修改。');
    assert.equal(restored.run('hasSentenceEdit()'), true);
    assert.equal(restored.run('localDecisions[0].note'), '需要补充藏品来源。');
    assert.equal(restored.run('currentRecord.decisions[0].note'), '');
    assert.equal(restored.requests.some(path => path.endsWith('/decisions')), false);
  }],
  ['three-way opinion recovery preserves independent server changes', async () => {
    const h = await fresh();
    const draft = await seedReviewDraft(h);
    draft.decisions[0] = { index: 0, state: 'pending', note: '草稿修改第一句。' };
    h.storageData.set(reviewKey(h.record.review_id), JSON.stringify(draft));
    h.run("currentRecord.decisions[1] = { index: 1, state: 'dismissed', note: '另一页面已保存第二句。' }; currentRecord.decisions_revision = 1; localDecisions = currentRecord.decisions.map(item => ({...item})); initializeDrafts()");
    assert.equal(h.run('recoverLocalDraft()'), true);
    assert.equal(h.run('localDecisions[0].note'), '草稿修改第一句。');
    assert.equal(h.run('localDecisions[1].note'), '另一页面已保存第二句。');
    assert.equal(h.run('currentRecord.decisions[0].note'), '');
    assert.equal(h.run('currentRecord.decisions_revision'), 1);
  }],
  ['conflicting opinions require an explicit text-only restore and export', async () => {
    const h = await fresh();
    const draft = await seedReviewDraft(h, { text: '草稿中的修改正文。' });
    draft.decisions[0] = { index: 0, state: 'pending', note: '本机草稿意见。' };
    h.storageData.set(reviewKey(h.record.review_id), JSON.stringify(draft));
    h.run("currentRecord.decisions[0] = { index: 0, state: 'dismissed', note: '服务器最新意见。' }; currentRecord.decisions_revision = 1; localDecisions = currentRecord.decisions.map(item => ({...item})); initializeDrafts()");
    assert.equal(h.run('recoverLocalDraft()'), false);
    assert.equal(h.ids.get('document-preview').value, h.record.normalized_text);
    assert.equal(h.run('localDecisions[0].note'), '服务器最新意见。');
    assert.equal(h.ids.get('recover-draft-text').hidden, false);
    assert.match(h.ids.get('local-draft-status').textContent, /人工意见已有更新/);
    assert.equal(h.run('recoverLocalDraft(true)'), true);
    assert.equal(h.ids.get('document-preview').value, draft.text);
    assert.equal(h.run('localDecisions[0].note'), '服务器最新意见。');
    assert.equal(h.downloadLinks.length, 1);
    assert.match(h.downloadLinks[0].download, /草稿备份\.txt$/);
  }],
  ['storage failures keep editing available and never claim a successful save', async () => {
    const h = await fresh();
    h.localStorage.error = new Error('Quota exceeded');
    fillNew(h);
    assert.equal(h.run('flushDraftSave()'), false);
    assert.equal(h.run('isLocalDraftSaved()'), false);
    assert.equal(h.ids.get('document-preview').readOnly, false);
    assert.equal(h.ids.get('local-draft-status').dataset.state, 'error');
    assert.equal(h.ids.get('retry-local-draft').hidden, false);
    assert.equal(h.ids.get('export-local-draft').hidden, false);
    assert.equal(h.storageData.has(NEW_KEY), false);
    h.localStorage.error = null;
    h.ids.get('retry-local-draft').click();
    assert.equal(h.run('isLocalDraftSaved()'), true);
    assert.equal(stored(h).text, h.ids.get('document-preview').value);
  }],
  ['a competing tab cannot be overwritten by a stale autosave', async () => {
    const h = await fresh(); fillNew(h); save(h);
    const other = { ...stored(h), text: '另一页面最新保存的正文。' };
    h.storageData.set(NEW_KEY, JSON.stringify(other));
    input(h, 'document-preview', '本页尚未保存的正文。');
    assert.equal(h.run('flushDraftSave()'), false);
    assert.equal(stored(h).text, other.text);
    assert.equal(h.ids.get('document-preview').value, '本页尚未保存的正文。');
    assert.equal(h.run('isLocalDraftSaved()'), false);
    assert.match(h.ids.get('local-draft-status').textContent, /其他页面更新/);
    h.run('discardLocalDraft()');
    assert.equal(stored(h).text, '本页尚未保存的正文。');
    assert.equal(h.run('isLocalDraftSaved()'), true);
  }],
  ['storage events pause stale drafts and re-check before recovery', async () => {
    const h = await fresh(); fillNew(h); save(h);
    h.storageData.set(NEW_KEY, JSON.stringify({ ...stored(h), text: '另一页面的初次修改。' }));
    h.windowEvents.get('storage')({ key: NEW_KEY });
    assert.equal(h.run('draftSession.pending.text'), '另一页面的初次修改。');
    h.storageData.set(NEW_KEY, JSON.stringify({ ...stored(h), text: '另一页面再次修改。' }));
    assert.equal(h.run('recoverLocalDraft()'), false);
    assert.equal(h.ids.get('document-preview').value, '棉袍采用对襟设计。');
    assert.equal(h.run('recoverLocalDraft()'), true);
    assert.equal(h.ids.get('document-preview').value, '另一页面再次修改。');
  }],
  ['a competing tab deletion still exposes a way to preserve current edits', async () => {
    const h = await fresh(); fillNew(h); save(h);
    input(h, 'document-preview', '本页仍需保留的文稿。');
    h.storageData.delete(NEW_KEY);
    h.windowEvents.get('storage')({ key: NEW_KEY });
    assert.equal(h.run('flushDraftSave()'), false);
    assert.equal(h.ids.get('local-draft-recovery').hidden, false);
    assert.equal(h.ids.get('recover-local-draft').disabled, true);
    assert.equal(h.ids.get('discard-local-draft').disabled, false);
    h.ids.get('discard-local-draft').click();
    assert.equal(stored(h).text, '本页仍需保留的文稿。');
    assert.equal(h.run('isLocalDraftSaved()'), true);
  }],
  ['clearing cancels pending autosaves and cannot resurrect the document', async () => {
    const h = await fresh(); fillNew(h); save(h);
    input(h, 'document-preview', '清空前尚未到暂存时间的内容。');
    h.run('handleClear()');
    assert.equal(h.ids.get('document-preview').value, '');
    assert.equal(h.storageData.has(NEW_KEY), false);
    await pause(550);
    assert.equal(h.storageData.has(NEW_KEY), false);
    const restored = await fresh(h.storageData);
    assert.equal(restored.ids.get('local-draft-recovery').hidden, true);
  }],
  ['failed review preserves the draft and a successful review consumes it', async () => {
    const h = await fresh(); fillNew(h, h.record.normalized_text);
    h.reviewResponse = h.response({ error: '测试服务不可用。' }, 503);
    await h.run('handleReviewClick()');
    assert.equal(stored(h).text, h.record.normalized_text);
    assert.equal(h.run('currentRecord'), null);
    h.reviewResponse = null;
    await h.run('handleReviewClick()');
    // Finish the real review callback without waiting for its presentation timer.
    h.run('clearInterval(playTimer); playTimer = null; playQueue = []; finishReview(activeReview)');
    assert.equal(h.run('currentRecord.review_id'), 'b'.repeat(32));
    assert.equal(h.storageData.has(NEW_KEY), false);
    assert.equal(h.run('draftSession.reviewId'), 'b'.repeat(32));
    assert.equal(h.run('draftHasContent()'), false);
  }],
  ['review completion cannot consume a newer draft saved by another tab', async () => {
    const h = await fresh(); fillNew(h, h.record.normalized_text);
    await h.run('handleReviewClick()');
    const newer = { ...stored(h), text: '另一标签在审阅期间新增的内容。' };
    h.storageData.set(NEW_KEY, JSON.stringify(newer));
    h.windowEvents.get('storage')({ key: NEW_KEY });
    h.run('clearInterval(playTimer); playTimer = null; playQueue = []; finishReview(activeReview)');
    assert.equal(h.run('currentRecord.review_id'), 'b'.repeat(32));
    assert.equal(stored(h).text, newer.text);
  }],
  ['a conflict discovered immediately before review prevents submission', async () => {
    const h = await fresh(); fillNew(h); save(h);
    h.storageData.set(NEW_KEY, JSON.stringify({ ...stored(h), text: '尚未通知本页的外部更新。' }));
    input(h, 'document-preview', '本页输入。');
    const count = h.requests.length;
    await h.run('handleReviewClick()');
    assert.equal(h.requests.slice(count).includes('/api/review'), false);
    assert.equal(h.run('activeReview'), null);
    assert.equal(stored(h).text, '尚未通知本页的外部更新。');
  }],
  ['failed upload retains the document and its existing backup', async () => {
    const h = await fresh(); fillNew(h); save(h);
    const before = h.storageData.get(NEW_KEY);
    h.extractResponse = h.response({ error: '测试文档读取失败。' }, 503);
    h.ids.get('document-file').files = [{ name: '替换文稿.docx', size: 32 }];
    await h.run('handleDocumentChange()');
    assert.equal(h.ids.get('document-preview').value, '棉袍采用对襟设计。');
    assert.equal(h.storageData.get(NEW_KEY), before);
    assert.match(h.ids.get('document-status').textContent, /失败/);
  }],
  ['importing from an archive leaves an unrelated new-document backup intact', async () => {
    const h = await fresh(); fillNew(h, '此前的新文稿备份。'); save(h);
    const before = h.storageData.get(NEW_KEY);
    await openRecord(h);
    h.extractResponse = h.response({ text: '本次导入的新正文。' });
    h.ids.get('document-file').files = [{ name: '新展签.docx', size: 32 }];
    await h.run('handleDocumentChange()');
    assert.equal(h.ids.get('document-preview').value, '本次导入的新正文。');
    assert.equal(h.run('currentRecord'), null);
    assert.equal(h.storageData.get(NEW_KEY), before);
    assert.equal(h.run('draftSession.pending.text'), '此前的新文稿备份。');
    assert.equal(h.run('flushDraftSave()'), false);
  }],
  ['pending recovery prevents upload until the user resolves the draft', async () => {
    const first = await fresh(); fillNew(first); save(first);
    const h = await fresh(first.storageData);
    h.extractResponse = h.response({ text: '不应覆盖待恢复草稿。' });
    h.ids.get('document-file').files = [{ name: '新展签.docx', size: 32 }];
    await h.run('handleDocumentChange()');
    assert.equal(h.requests.includes('/api/extract'), false);
    assert.equal(h.ids.get('document-preview').value, '');
    assert.equal(h.storageData.get(NEW_KEY), first.storageData.get(NEW_KEY));
  }],
  ['an external draft update during upload preserves both originals', async () => {
    const h = await fresh(); fillNew(h); save(h);
    let resolveExtract;
    h.extractResponse = new Promise(resolve => { resolveExtract = resolve; });
    h.ids.get('document-file').files = [{ name: '新展签.docx', size: 32 }];
    const importing = h.run('handleDocumentChange()');
    await h.flush();
    const newer = { ...stored(h), text: '另一标签在提取期间新增的内容。' };
    h.storageData.set(NEW_KEY, JSON.stringify(newer));
    h.windowEvents.get('storage')({ key: NEW_KEY });
    resolveExtract(h.response({ text: '这次提取的内容先不替换。' }));
    await importing;
    assert.equal(h.ids.get('document-preview').value, '棉袍采用对襟设计。');
    assert.equal(stored(h).text, newer.text);
    assert.equal(h.run('draftSession.pending.text'), newer.text);
  }],
  ['startup source loading disables input until drafts can be initialized', async () => {
    const h = await fresh();
    let resolveSources;
    h.sourcesResponse = new Promise(resolve => { resolveSources = resolve; });
    const initializing = h.run('initializeWorkspace()');
    await h.flush();
    assert.equal(h.ids.get('document-preview').readOnly, true);
    assert.equal(h.ids.get('document-title').disabled, true);
    assert.equal(h.ids.get('document-file').disabled, true);
    assert.equal(h.ids.get('source-select').disabled, true);
    resolveSources(h.response(h.sourcesData)); await initializing;
    assert.equal(h.ids.get('document-preview').readOnly, false);
    assert.equal(h.ids.get('document-title').disabled, false);
  }],
  ['a failed local deletion never clears the visible document', async () => {
    const h = await fresh(); fillNew(h); save(h);
    const before = h.storageData.get(NEW_KEY);
    h.localStorage.error = new Error('Storage access denied');
    h.run('handleClear()');
    assert.equal(h.ids.get('document-preview').value, '棉袍采用对襟设计。');
    assert.equal(h.storageData.get(NEW_KEY), before);
    assert.equal(h.ids.get('local-draft-status').dataset.state, 'error');
    h.localStorage.error = null;
    h.run('handleClear()');
    assert.equal(h.ids.get('document-preview').value, '');
    assert.equal(h.storageData.has(NEW_KEY), false);
  }],
  ['saving one opinion updates its draft base and retains other unfinished edits', async () => {
    const h = await fresh(); await openRecord(h);
    input(h, 'document-preview', `${h.record.normalized_text}\n正文仍待复核。`);
    editOpinion(h, 0, 'pending', '第一句保存到档案。');
    editOpinion(h, 1, 'pending', '第二句仅保存在草稿。');
    save(h);
    await h.run('saveDecisions(0)');
    const draft = stored(h, reviewKey(h.record.review_id));
    assert.equal(draft.base_decisions[0].note, '第一句保存到档案。');
    assert.equal(draft.base_decisions[1].note, '');
    assert.equal(draft.decisions[1].note, '第二句仅保存在草稿。');
    assert.match(draft.text, /正文仍待复核/);
    assert.equal(draft.decisions_revision, 1);
    assert.equal(h.run('currentRecord.decisions[1].note'), '');
  }],
  ['page hide and visibility changes flush the latest input', async () => {
    const h = await fresh(); fillNew(h, '页面隐藏前的修改。');
    h.document.visibilityState = 'hidden';
    h.documentEvents.get('visibilitychange')();
    assert.equal(stored(h).text, '页面隐藏前的修改。');
    input(h, 'document-preview', '关闭标签页前的修改。');
    h.windowEvents.get('pagehide')();
    assert.equal(stored(h).text, '关闭标签页前的修改。');
  }],
  ['damaged local storage is retained until the user explicitly discards it', async () => {
    const h = await fresh([[NEW_KEY, '{broken-json']]);
    assert.equal(h.ids.get('local-draft-recovery').hidden, false);
    assert.equal(h.ids.get('recover-local-draft').disabled, true);
    fillNew(h, '当前页面仍然可以继续编辑。');
    assert.equal(h.run('flushDraftSave()'), false);
    assert.equal(h.storageData.get(NEW_KEY), '{broken-json');
    h.run('discardLocalDraft()');
    assert.equal(stored(h).text, '当前页面仍然可以继续编辑。');
  }],
  ['restoring unavailable sources does not enable review with missing evidence', async () => {
    const h = await fresh(); fillNew(h); save(h);
    const draft = { ...stored(h), source_id: 404 };
    const restored = await fresh([[NEW_KEY, JSON.stringify(draft)]]);
    assert.equal(restored.run('recoverLocalDraft()'), true);
    assert.equal(restored.ids.get('source-select').value, '404');
    assert.equal(restored.ids.get('review-document').disabled, true);
    assert.equal(restored.run('availableSourceIds.has(404)'), false);
    assert.match(restored.ids.get('source-select').children.at(-1).textContent, /当前不可用/);
  }],
];

(async () => {
  for (const [name, test] of cases) {
    try { await test(); }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    finally { for (const h of activeHarnesses) h.close(); activeHarnesses.clear(); }
  }
  console.log(`PASS: ${cases.length} draft recovery integration scenarios, including explicit restoration, archive isolation, opinion conflicts, unapplied sentence edits, storage failures, competing tabs and review lifecycle`);
})().catch(error => { console.error(error); process.exitCode = 1; });

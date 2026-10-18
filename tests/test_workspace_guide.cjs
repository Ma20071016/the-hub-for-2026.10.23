/* Real workbench scripts, disposable VM/Storage/HTTP fixtures; no live requests. */
const assert = require('node:assert/strict');
const harnessPath = require.resolve('./test_workflow_frontend.cjs');
const active = new Set();
const title = '新疆喀什维吾尔族绿棉袍';
const sourceURL = 'http://biftmuseum.com/collection/info?sid=14671&nationSid=5&colCatSid=2&nationName=维吾尔族';
const quotes = [
  '衣身宽大、造型简洁，对襟，两侧缝开短衩，衣身可见明显绗缝线迹，门襟处由于线迹紧密而出轻微褶皱。袖口、门襟、底摆均装饰有黄、白、黑色毛线编结的窄线条装饰。',
  '此件棉袍质地为棉质色织布，衣身蓝绿色兼织黄、紫、红色。衣里为木戳印花工艺印制的碎花棉布，里子衣襟贴边为黄绿色艾德莱斯绸面料。',
];
const detail = () => ({ source: { id: 9, title, source_url: sourceURL },
  evidence: quotes.map((text, i) => ({ id: i + 10, text, object_name: title })) });
async function fresh(address = '/') {
  delete require.cache[harnessPath];
  const h = require(harnessPath); active.add(h);
  await h.flush();
  h.sourcesResponse = h.response({ approved_count: 2, sources: [{ id: 9, title, object_name: title }] });
  h.libraryResponse = h.response(detail());
  h.setAddress(address);
  await h.run('initializeWorkspace()');
  return h;
}
const input = (h, id, value) => { h.ids.get(id).value = value; h.run('syncWorkspace()'); };
const text = h => h.ids.get('document-preview').value;
const load = h => h.run('loadGuideExample()');
const unchanged = h => { assert.equal(text(h), ''); assert.equal(h.ids.get('document-title').value, ''); };

(async () => {
  // 1. A guide link only exposes a manual entry; no prefill, inference or history writes.
  const h = await fresh('/index.html?example=robe-demo');
  assert.equal(h.ids.get('workspace-guide').open, true);
  unchanged(h);
  assert.equal(h.requests.filter(p => p.startsWith('/api/library/')).length, 0);
  assert.equal(h.ids.get('load-guide-example').disabled, false);
  // 2. Explicit load resolves the current ID, checks evidence, marks the sample and saves only a draft.
  await load(h);
  assert.equal(h.ids.get('source-select').value, '9');
  assert.match(h.ids.get('document-title').value, /^【教学示例】/);
  assert.equal(text(h).split('\n').length, 3);
  assert.match(text(h), /通体为红色/);
  assert.equal(h.ids.get('guide-example-notice').hidden, false);
  assert.equal(h.ids.get('document-preview-box').hidden, false);
  assert.equal(h.document.activeElement.id, 'document-preview');
  assert.equal(h.requests.filter(p => p === '/api/review').length, 0);
  const draft = JSON.parse(h.storageData.get('cmit:workspace-draft:v1:new'));
  assert.equal(draft.title, h.ids.get('document-title').value);
  assert.equal(draft.review_id, null);
  assert.equal(h.run('currentRecord'), null);
  assert.equal(h.ids.get('load-guide-example').disabled, true);
  // 3. Partial user input, a selected source, and file selection each block even direct invocation.
  for (const [id, value] of [['document-title', '我的标题'], ['document-preview', '我的草稿'], ['source-select', '9'], ['document-file', 'C:\\fakepath\\稿件.docx']]) {
    const item = await fresh(); input(item, id, value);
    const before = item.run('guideWorkspaceSnapshot()'); const count = item.requests.length;
    await load(item);
    assert.equal(item.run('guideWorkspaceSnapshot()'), before); assert.equal(item.requests.length, count);
  }
  // 4. Pending, broken and unavailable browser storage cannot be replaced by a sample.
  for (const raw of [JSON.stringify(draft), 'broken']) {
    const item = await fresh(); item.storageData.set('cmit:workspace-draft:v1:new', raw);
    item.run('initializeDrafts(); syncWorkspace()'); await load(item); unchanged(item);
    assert.equal(item.storageData.get('cmit:workspace-draft:v1:new'), raw);
    item.run('discardLocalDraft()');
    assert.equal(item.ids.get('load-guide-example').disabled, false);
  }
  const unavailable = await fresh(); unavailable.localStorage.error = new Error('blocked');
  unavailable.run('initializeDrafts(); syncWorkspace()'); await load(unavailable); unchanged(unavailable);
  // 5. Archive context wins over sample links, including an invalid archive link.
  for (const review of ['a'.repeat(32), 'invalid']) {
    const item = await fresh(`/index.html?review=${review}&example=robe-demo`);
    const before = item.run('guideWorkspaceSnapshot()'); await load(item);
    assert.equal(item.run('guideWorkspaceSnapshot()'), before);
    assert.equal(item.requests.some(p => p.startsWith('/api/library/')), false);
  }
  // 6. Incorrect/ambiguous source or changed/unapproved quote never fills a document.
  for (const mutate of [d => { d.source.source_url = 'https://wrong.invalid'; },
    d => { d.source.id = 1; }, d => { d.source.title = '同名替代藏品'; },
    d => { d.evidence[0].object_name = '另一对象'; }, d => { d.evidence[0].text += '改'; },
    d => { d.evidence.pop(); }, d => { d.evidence.push({ ...d.evidence[0] }); }]) {
    const item = await fresh(); const bad = detail(); mutate(bad); item.libraryResponse = item.response(bad);
    await load(item); unchanged(item); assert.match(item.ids.get('guide-example-status').textContent, /变化/);
  }
  const ambiguous = await fresh(); ambiguous.run('guideSourceMatches = [9, 10]; syncWorkspace()');
  await load(ambiguous); unchanged(ambiguous);
  // 7. Failure is retryable; no half-filled sample is left behind.
  const failed = await fresh(); failed.libraryResponse = failed.response({ error: '服务暂不可用' }, 503);
  await load(failed); unchanged(failed); assert.equal(failed.ids.get('load-guide-example').disabled, false);
  failed.libraryResponse = failed.response(detail()); await load(failed); assert.ok(text(failed));
  // 8. Loading locks editing, duplicate calls, clear and review; stale input wins over the sample.
  const slow = await fresh(); let resolve;
  slow.libraryResponse = new Promise(done => { resolve = done; });
  const pending = load(slow); await slow.flush();
  assert.equal(slow.ids.get('document-preview').readOnly, true);
  assert.equal(slow.ids.get('review-document').disabled, true);
  const count = slow.requests.length;
  await load(slow); slow.run('handleClear()'); await slow.run('handleReviewClick()');
  assert.equal(slow.requests.length, count);
  input(slow, 'document-title', '保留期间输入'); resolve(slow.response(detail())); await pending;
  assert.equal(slow.ids.get('document-title').value, '保留期间输入'); assert.equal(text(slow), '');
  // 9. A competing tab's draft written while the source loads is preserved.
  const race = await fresh(); let complete;
  race.libraryResponse = new Promise(done => { complete = done; }); const racing = load(race);
  await race.flush(); const other = JSON.stringify({ ...draft, title: '另一页面草稿' });
  race.storageData.set('cmit:workspace-draft:v1:new', other); complete(race.response(detail())); await racing;
  unchanged(race); assert.equal(race.storageData.get('cmit:workspace-draft:v1:new'), other);
  assert.equal(race.run('draftSession.external'), true);
  // 10. Invalid and conflicting URL parameters do not auto-fill or override source selection.
  for (const address of ['/?example=unknown', '/?example=robe-demo&example=robe-demo', '/?example=robe-demo&source=9']) {
    const item = await fresh(address); assert.equal(text(item), ''); assert.match(item.ids.get('guide-example-status').textContent, /无效|保留/);
  }
  // 11. Next-step navigation only focuses the action; it does not submit anything.
  const next = await fresh(); next.ids.get('guide-next').click();
  assert.equal(next.ids.get('workspace-guide').open, false);
  assert.equal(next.document.activeElement.id, 'choose-document');
  input(next, 'document-preview', '我的正文。');
  next.ids.get('guide-next').click(); assert.equal(next.document.activeElement.id, 'source-picker-search');
  assert.equal(next.ids.get('source-picker-dialog').open, true);
  next.ids.get('source-picker-close').click();
  input(next, 'source-select', '9'); next.ids.get('guide-next').click();
  assert.equal(next.document.activeElement.id, 'review-document');
  assert.equal(next.requests.includes('/api/review'), false);
  // 12. The guide reflects saved/pending opinions and unsaved text, without claiming all content is correct.
  const record = await fresh(); record.run('adoptRecord(validateDoneEvent(clone(record))); initializeDrafts(); syncWorkspace()');
  assert.match(record.ids.get('guide-current-step').textContent, /未记人工意见/);
  record.run("localDecisions[0].state = 'pending'; syncWorkspace()");
  assert.match(record.ids.get('guide-current-step').textContent, /尚未保存/);
  record.run("localDecisions.forEach(item => item.state = 'pending'); currentRecord.decisions = localDecisions.map(item => ({...item})); syncWorkspace()");
  assert.match(record.ids.get('guide-current-step').textContent, /仍有待补证/);
  input(record, 'document-preview', '已修改的正文。');
  assert.match(record.ids.get('guide-current-step').textContent, /生成新版本/);
  // 13. Restoring a sample draft retains its explicit teaching label.
  const restored = await fresh(); restored.storageData.set('cmit:workspace-draft:v1:new', JSON.stringify(draft));
  restored.run('initializeDrafts(); recoverLocalDraft()');
  assert.equal(restored.ids.get('guide-example-notice').hidden, false);
  assert.equal(restored.ids.get('document-title').value, draft.title);
  console.log('PASS: 13 onboarding/workbench scenarios, including manual sample load, evidence binding, draft isolation, concurrent changes and next-step navigation');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => active.forEach(h => h.close()));

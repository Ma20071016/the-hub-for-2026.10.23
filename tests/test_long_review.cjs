/* Long-document review controls against production scripts and isolated fixtures.
 * Run: node tests/test_long_review.cjs
 * These checks exercise behavior; real-browser checks cover sticky layout.
 */
const assert = require('node:assert/strict');
const harnessPath = require.resolve('./test_workflow_frontend.cjs');
const active = new Set();
const node = (h, id) => {
  const result = h.ids.get(id);
  assert.ok(result, `Expected interface element #${id}`);
  return result;
};
const descendants = root => (root.children || []).flatMap(child => [child, ...descendants(child)]);
const visibleIndexes = h => h.run('currentRecord.results.map(r => r.index)')
  .filter(index => !node(h, `sentence-result-${index}`).hidden);
const plain = value => JSON.parse(JSON.stringify(value));

function mixedRecord(h) {
  const record = h.clone(h.record);
  const statuses = ['supported', 'uncovered', 'refute', 'insufficient', 'conflicting', 'refute', 'supported', 'insufficient'];
  let offset = 0;
  record.review_id = 'c'.repeat(32);
  record.results = statuses.map((status, index) => {
    const result = h.clone(h.record.results[0]);
    result.index = index;
    result.sentence = `第${index + 1}件服饰采用对襟设计。`;
    result.sentence_start = offset;
    offset += Array.from(result.sentence).length;
    result.sentence_end = offset++;
    result.status = status;
    result.reason = status === 'uncovered' ? 'no_evidence' : 'long_review_fixture';
    result.message = `测试判定：${status}`;
    const stances = { supported: ['supports'], uncovered: [], refute: ['refutes'], insufficient: ['insufficient'], conflicting: ['supports', 'refutes'] }[status];
    result.evidence = stances.map((stance, position) => ({
      ...h.clone(h.record.results[0].evidence[0]),
      evidence_id: index * 2 + position + 1, stance,
      evidence: `第 ${index + 1} 句的第 ${position + 1} 条原文。`,
      scores: { supports: stance === 'supports' ? 0.9 : 0.05, refutes: stance === 'refutes' ? 0.9 : 0.05, insufficient: stance === 'insufficient' ? 0.9 : 0.05 },
    }));
    return result;
  });
  record.normalized_text = record.results.map(result => result.sentence).join('\n');
  record.decisions = ['confirmed', 'pending', 'unreviewed', 'dismissed', 'unreviewed', 'unreviewed', 'unreviewed', 'unreviewed']
    .map((state, index) => ({ index, state, note: '' }));
  record.stats = {
    total_sentences: 8, checked_sentences: 7, problems_found: 2, supported_sentences: 2,
    refuted_sentences: 2, insufficient_sentences: 2, conflicting_sentences: 1,
    uncovered_sentences: 1, no_evidence_sentences: 1, low_relevance_sentences: 0,
    noise_sentences: 0, coverage_ratio: 7 / 8,
  };
  return record;
}

async function fresh({ mixed = true, empty = false } = {}) {
  delete require.cache[harnessPath];
  const h = require(harnessPath);
  active.add(h);
  await h.flush();
  if (!empty) {
    h.context.reviewFixture = mixed ? mixedRecord(h) : h.clone(h.record);
    h.run('adoptRecord(validateDoneEvent(clone(reviewFixture)))');
  }
  return h;
}
const setState = (h, index, state) => {
  node(h, `decision-state-${index}`).value = state;
  node(h, `decision-state-${index}`).events.change();
};
const setNote = (h, index, note) => {
  node(h, `decision-note-${index}`).value = note;
  node(h, `decision-note-${index}`).events.input();
};
const setCompact = (h, compact) => {
  node(h, 'review-view-compact').checked = compact;
  node(h, 'review-view-compact').events.change();
};
const filter = (h, type, value) => node(h, `${type === 'model' ? 'result' : 'decision'}-filter-${value}`).click();
const next = h => node(h, 'next-unreviewed').click();
const focusedIndex = h => Number(h.document.activeElement.id.replace('sentence-result-', ''));
const progress = h => node(h, 'review-processing-progress').textContent;
const cases = [
  ['progress separates completed decisions from pending evidence and reflects unsaved edits', async () => {
    const h = await fresh();
    assert.equal(node(h, 'review-processing-toolbar').hidden, false);
    assert.match(progress(h), /共 8 句.*已完成 2 句.*待处理 6 句/);
    setState(h, 2, 'pending');
    assert.match(progress(h), /已完成 2 句.*待处理 6 句/);
    setState(h, 2, 'confirmed');
    assert.match(progress(h), /已完成 3 句.*待处理 5 句/);
    assert.equal(h.run('decisionsDirty()'), true);
    assert.equal(h.run('currentRecord.decisions[2].state'), 'unreviewed');
    assert.equal(h.run('currentRecord.results[2].status'), 'refute');
    assert.match(node(h, 'decision-save-status').textContent, /未保存/);
  }],
  ['human filters intersect model filters without renumbering or changing results', async () => {
    const h = await fresh();
    const before = h.run('JSON.stringify(currentRecord.results)');
    filter(h, 'human', 'unreviewed');
    assert.deepEqual(plain(visibleIndexes(h)), [2, 4, 5, 6, 7]);
    filter(h, 'model', 'supported');
    assert.deepEqual(plain(visibleIndexes(h)), [6]);
    filter(h, 'human', 'completed');
    assert.deepEqual(plain(visibleIndexes(h)), [0]);
    filter(h, 'human', 'pending');
    assert.deepEqual(plain(visibleIndexes(h)), []);
    assert.equal(node(h, 'result-group-supported').hidden, true);
    filter(h, 'model', 'all');
    assert.deepEqual(plain(visibleIndexes(h)), [1]);
    assert.equal(node(h, 'decision-filter-pending').getAttribute('aria-pressed'), 'true');
    assert.equal(h.run('JSON.stringify(currentRecord.results)'), before);
  }],
  ['next unreviewed follows displayed priority groups, skips handled states and wraps', async () => {
    const h = await fresh();
    const visited = [];
    for (let count = 0; count < 6; count++) { next(h); visited.push(focusedIndex(h)); }
    assert.deepEqual(visited, [2, 5, 4, 7, 6, 2]);
    assert.equal(node(h, 'decision-filter-unreviewed').getAttribute('aria-pressed'), 'true');
    assert.equal(node(h, 'sentence-result-2').hidden, false);
    assert.ok(node(h, 'sentence-result-2').lastScrollIntoView);
    assert.match(node(h, 'review-navigation-status').textContent, /第 3 句/);
    assert.equal(h.run('decisionsDirty()'), false);
  }],
  ['next unreviewed respects model filter and remains available from pending filter', async () => {
    const h = await fresh();
    filter(h, 'model', 'supported');
    filter(h, 'human', 'pending');
    assert.equal(node(h, 'next-unreviewed').disabled, false);
    next(h);
    assert.equal(focusedIndex(h), 6);
    assert.deepEqual(plain(visibleIndexes(h)), [6]);
    assert.equal(node(h, 'result-filter-supported').getAttribute('aria-pressed'), 'true');
    filter(h, 'model', 'uncovered');
    assert.equal(node(h, 'next-unreviewed').disabled, true);
    const prior = h.document.activeElement;
    next(h);
    assert.equal(h.document.activeElement, prior);
  }],
  ['changing and saving the current filtered decision retains its controls until explicit navigation', async () => {
    const h = await fresh({ mixed: false });
    next(h);
    const index = focusedIndex(h);
    setState(h, index, 'confirmed');
    assert.equal(node(h, `sentence-result-${index}`).hidden, false);
    setNote(h, index, '处理过程中继续填写的备注。');
    assert.equal(node(h, `sentence-result-${index}`).hidden, false);
    assert.equal(node(h, `save-decision-${index}`).disabled, false);
    await node(h, `save-decision-${index}`).click();
    await h.flush();
    assert.equal(node(h, `sentence-result-${index}`).hidden, false);
    assert.equal(h.lastBody.decisions[index].note, '处理过程中继续填写的备注。');
    assert.equal(h.run(`currentRecord.decisions[${index}].state`), 'confirmed');
    next(h);
    assert.equal(node(h, `sentence-result-${index}`).hidden, true);
  }],
  ['moving next releases retained cards without discarding unsaved decisions', async () => {
    const h = await fresh();
    next(h);
    assert.equal(focusedIndex(h), 2);
    setState(h, 2, 'pending');
    setNote(h, 2, '等待补充馆藏资料。');
    next(h);
    assert.equal(focusedIndex(h), 5);
    assert.equal(node(h, 'sentence-result-2').hidden, true);
    assert.equal(h.run('localDecisions[2].note'), '等待补充馆藏资料。');
    filter(h, 'human', 'pending');
    assert.equal(node(h, 'sentence-result-2').hidden, false);
    assert.equal(node(h, 'decision-note-2').value, '等待补充馆藏资料。');
  }],
  ['failed decision save retains the filtered sentence, note and retry action', async () => {
    const h = await fresh({ mixed: false });
    next(h);
    const index = focusedIndex(h);
    setState(h, index, 'pending');
    setNote(h, index, '保存失败后仍要保留的补证备注。');
    h.saveResponse = h.response({ error: '保存服务暂时不可用，请重试。' }, 503);
    await node(h, `save-decision-${index}`).click();
    await h.flush();
    assert.equal(node(h, `sentence-result-${index}`).hidden, false);
    assert.equal(node(h, `decision-note-${index}`).value, '保存失败后仍要保留的补证备注。');
    assert.equal(node(h, `decision-save-status-${index}`).dataset.state, 'error');
    assert.equal(node(h, `save-decision-${index}`).disabled, false);
    assert.equal(h.run(`currentRecord.decisions[${index}].state`), 'unreviewed');
    h.saveResponse = null;
    await node(h, `save-decision-${index}`).click();
    await h.flush();
    assert.equal(node(h, `decision-save-status-${index}`).dataset.state, 'saved');
    assert.equal(node(h, `sentence-result-${index}`).hidden, false);
    filter(h, 'human', 'unreviewed');
    assert.equal(node(h, `sentence-result-${index}`).hidden, true);
  }],
  ['compact cards preserve evidence, decision controls, notes and explicit expansion', async () => {
    const h = await fresh();
    const card = node(h, 'sentence-result-2');
    const evidence = descendants(card).filter(item => item.tagName === 'blockquote').map(item => item.textContent);
    assert.equal(node(h, 'result-details-2').hidden, false);
    setNote(h, 2, '切换视图仍保留的备注。');
    const originalInput = node(h, 'decision-note-2');
    setCompact(h, true);
    assert.equal(node(h, 'result-details-2').hidden, true);
    assert.equal(node(h, 'toggle-result-details-2').getAttribute('aria-expanded'), 'false');
    node(h, 'toggle-result-details-2').click();
    assert.equal(node(h, 'result-details-2').hidden, false);
    assert.equal(node(h, 'toggle-result-details-2').getAttribute('aria-expanded'), 'true');
    assert.equal(node(h, 'decision-note-2'), originalInput);
    assert.equal(originalInput.value, '切换视图仍保留的备注。');
    assert.deepEqual(descendants(card).filter(item => item.tagName === 'blockquote').map(item => item.textContent), evidence);
    setCompact(h, false);
    assert.equal(node(h, 'result-details-2').hidden, false);
    const evidencePanel = descendants(card).find(item => item.className === 'evidence-details');
    assert.equal(evidencePanel.open, true);
    assert.equal(h.run('localDecisions[2].note'), originalInput.value);
  }],
  ['jumping in compact view expands the target for immediate processing', async () => {
    const h = await fresh();
    setCompact(h, true);
    assert.equal(node(h, 'result-details-2').hidden, true);
    next(h);
    assert.equal(focusedIndex(h), 2);
    assert.equal(node(h, 'result-details-2').hidden, false);
    assert.equal(node(h, 'result-details-5').hidden, true);
  }],
  ['return from sentence editing reveals a card hidden by both filters', async () => {
    const h = await fresh();
    node(h, 'locate-sentence-2').click();
    filter(h, 'model', 'supported');
    filter(h, 'human', 'completed');
    assert.equal(node(h, 'sentence-result-2').hidden, true);
    setCompact(h, true);
    node(h, 'return-to-result').click();
    assert.equal(node(h, 'sentence-result-2').hidden, false);
    assert.equal(node(h, 'result-group-refute').hidden, false);
    assert.equal(node(h, 'result-details-2').hidden, false);
    assert.equal(focusedIndex(h), 2);
  }],
  ['navigation cannot interrupt active requests or unapplied sentence input', async () => {
    const h = await fresh();
    for (const busy of ['workspaceInitializing', 'activeUpload', 'activeReview', 'activeHistory', 'activeSave', 'activeSourceSelection', 'activeExampleLoad']) {
      h.run(`${busy} = true; syncWorkspace()`);
      assert.equal(node(h, 'next-unreviewed').disabled, true, busy);
      const before = h.run('resultNavigationIndex');
      next(h);
      assert.equal(h.run('resultNavigationIndex'), before, busy);
      h.run(`${busy} = false; syncWorkspace()`);
    }
    node(h, 'locate-sentence-2').click();
    node(h, 'sentence-editor').value = '这句输入尚未应用。';
    node(h, 'sentence-editor').events.input();
    const before = h.run('activeSentenceIndex');
    next(h);
    assert.equal(h.run('activeSentenceIndex'), before);
    assert.equal(node(h, 'sentence-editor').value, '这句输入尚未应用。');
    assert.equal(h.run('hasSentenceEdit()'), true);
    assert.match(node(h, 'workflow-status').textContent, /未应用|应用到正文/);
  }],
  ['discard keeps same-record filters and view while changing records resets them', async () => {
    const h = await fresh();
    filter(h, 'model', 'refute');
    filter(h, 'human', 'pending');
    setCompact(h, true);
    setState(h, 2, 'pending');
    setNote(h, 2, '将撤销的本地备注。');
    h.run('discardDecisions()');
    assert.equal(node(h, 'result-filter-refute').getAttribute('aria-pressed'), 'true');
    assert.equal(node(h, 'decision-filter-pending').getAttribute('aria-pressed'), 'true');
    assert.equal(node(h, 'review-view-compact').checked, true);
    assert.equal(node(h, 'decision-note-2').value, '');
    assert.deepEqual(plain(visibleIndexes(h)), []);
    h.run('adoptRecord(validateDoneEvent(clone(record)))');
    assert.equal(node(h, 'result-filter-all').getAttribute('aria-pressed'), 'true');
    assert.equal(node(h, 'decision-filter-all').getAttribute('aria-pressed'), 'true');
    assert.equal(node(h, 'review-view-compact').checked, false);
    assert.deepEqual(plain(visibleIndexes(h)), [0, 1, 2]);
    assert.match(progress(h), /共 3 句.*已完成 0 句.*待处理 3 句/);
  }],
  ['restored local opinions update progress and human filters without altering saved decisions', async () => {
    const h = await fresh({ mixed: false });
    const draft = JSON.parse(h.run('JSON.stringify(captureLocalDraft())'));
    draft.decisions[0] = { index: 0, state: 'confirmed', note: '恢复的已核对意见。' };
    draft.decisions[1] = { index: 1, state: 'pending', note: '恢复的待补证意见。' };
    h.storageData.set(`cmit:workspace-draft:v1:review:${h.record.review_id}`, JSON.stringify(draft));
    h.run('initializeDrafts()');
    assert.equal(h.run('recoverLocalDraft()'), true);
    assert.match(progress(h), /共 3 句.*已完成 1 句.*待处理 2 句/);
    filter(h, 'human', 'pending');
    assert.deepEqual(plain(visibleIndexes(h)), [1]);
    assert.equal(node(h, 'decision-note-1').value, '恢复的待补证意见。');
    next(h);
    assert.equal(focusedIndex(h), 2);
    assert.equal(h.run('currentRecord.decisions[0].state'), 'unreviewed');
    assert.equal(h.run('currentRecord.decisions[1].state'), 'unreviewed');
    assert.equal(h.requests.some(path => path.endsWith('/decisions')), false);
  }],
  ['empty workspaces and fully handled records do not offer a dead next action', async () => {
    const empty = await fresh({ empty: true });
    assert.equal(empty.run('resultControls'), null);
    assert.equal(node(empty, 'review-result-box').hidden, true);
    assert.equal(empty.ids.has('review-processing-toolbar'), false);
    const h = await fresh();
    for (let index = 0; index < 8; index++) setState(h, index, index % 2 ? 'confirmed' : 'dismissed');
    assert.match(progress(h), /已完成 8 句.*待处理 0 句/);
    assert.equal(node(h, 'next-unreviewed').disabled, true);
    h.run('discardDecisions(); handleClear()');
    assert.equal(h.run('resultControls'), null);
    assert.equal(node(h, 'review-result-box').hidden, true);
    assert.equal(descendants(node(h, 'review-result')).some(item => item.id === 'next-unreviewed'), false);
  }],
];

(async () => {
  for (const [name, check] of cases) {
    try { await check(); }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    finally { active.forEach(h => h.close()); active.clear(); }
  }
  console.log(`PASS: ${cases.length} long-document review scenarios, including progress, combined filters, prioritized navigation, compact state, save preservation and reset`);
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => active.forEach(h => h.close()));

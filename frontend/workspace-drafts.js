/* Browser-only working copies. Official review records are saved by app.js. */
const draftStore = window.DraftStore.create(() => window.Account ? window.Account.storage() : window.localStorage);
let draftSession = null;
let draftSaveTimer = null;

function captureLocalDraft() {
  return {
    schema_version: 1, saved_at: new Date().toISOString(),
    review_id: currentRecord?.review_id || null,
    title: documentTitle.value, text: documentPreview.value,
    source_id: Number(sourceSelect.value) || null,
    record_text: currentRecord?.normalized_text ?? null,
    decisions_revision: currentRecord?.decisions_revision ?? null,
    base_decisions: currentRecord ? currentRecord.decisions.map(({ index, state, note }) => ({ index, state, note })) : [],
    decisions: currentRecord ? localDecisions.map(({ index, state, note }) => ({ index, state, note })) : [],
    sentence_edit: hasSentenceEdit() ? {
      index: activeSentenceIndex, base: sentenceEditBase,
      text: $('#sentence-editor').value, conflict: sentenceEditConflict,
    } : null,
  };
}

function draftHasContent() {
  return currentRecord ? hasDraftChanges() || decisionsDirty() || hasSentenceEdit()
    : Boolean(documentTitle.value || documentPreview.value);
}

function draftMatchesContext() {
  return Boolean(draftSession && draftSession.reviewId === (currentRecord?.review_id || null));
}

function sameDraftContent(left, right) {
  if (!left || !right) return false;
  const withoutTime = ({ saved_at, ...value }) => value;
  return JSON.stringify(withoutTime(left)) === JSON.stringify(withoutTime(right));
}

function isLocalDraftSaved() {
  return !draftHasContent() || Boolean(draftMatchesContext() && !draftSession.pending
    && !draftSession.error && sameDraftContent(draftSession.saved, captureLocalDraft()));
}

function initializeDrafts() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  // A failed archive load must never offer an unrelated new-document draft.
  if (!currentRecord && new URLSearchParams(window.location.search).has('review')) {
    draftSession = null;
    syncLocalDraftUI();
    return;
  }
  const reviewId = currentRecord?.review_id || null;
  const stored = draftStore.read(reviewId);
  draftSession = {
    reviewId, raw: stored.raw ?? null, pending: stored.ok ? stored.draft : null,
    dirty: false, error: stored.ok ? null : stored.reason,
    saved: null, savedAt: null, opinionConflict: false, external: false,
  };
  syncLocalDraftUI();
}

function syncLocalDraftUI() {
  const status = $('#local-draft-status');
  const session = draftMatchesContext() ? draftSession : null;
  const busy = sentenceBusy() || workspaceInitializing;
  const pending = session?.pending;
  const damaged = session?.error === 'invalid';
  $('#local-draft-recovery').hidden = !pending && !damaged && !session?.external;
  $('#recover-local-draft').disabled = busy || !pending;
  $('#discard-local-draft').disabled = busy;
  $('#recover-draft-text').hidden = !session?.opinionConflict;
  $('#recover-draft-text').disabled = busy;
  $('#retry-local-draft').hidden = !session?.error || Boolean(pending) || damaged;
  $('#retry-local-draft').disabled = busy;
  $('#export-local-draft').hidden = !pending && !draftHasContent();
  $('#export-local-draft').disabled = busy;
  $('#export-local-draft').textContent = pending && !draftHasContent() ? '导出上次草稿' : '导出当前草稿';
  $('#export-pending-draft').hidden = !pending || !draftHasContent();
  $('#export-pending-draft').disabled = busy;
  $('#discard-local-draft').textContent = session?.external ? '保留当前内容' : '舍弃旧草稿';
  status.dataset.state = session?.error ? 'error' : pending ? 'recovery' : session?.dirty ? 'saving' : 'saved';
  if (!session) status.textContent = '载入工作台后启用自动暂存';
  else if (session.error === 'unavailable') status.textContent = '本机暂存失败，浏览器存储不可用或空间不足。请重试或导出草稿备份。';
  else if (damaged) status.textContent = '上次草稿格式异常，暂未恢复。可舍弃旧草稿后继续。';
  else if (session.opinionConflict) status.textContent = '档案中的人工意见已有更新，草稿未覆盖当前内容。可导出备份并仅恢复文稿，再核对人工意见。';
  else if (session.error === 'conflict') status.textContent = '其他页面更新了这份草稿，本页暂存已暂停。请选择恢复另一页草稿，或保留当前内容。';
  else if (pending) status.textContent = session.dirty ? '有上次草稿待处理，本次输入尚未暂存。' : '发现上次未完成的草稿';
  else if (session.dirty) status.textContent = '正在暂存到本机…';
  else if (session.savedAt) status.textContent = `${formatRecordDate(session.savedAt)} 已暂存到本机`;
  else status.textContent = currentRecord ? '编辑后自动暂存；已留档内容可在审阅档案中查看。' : '输入后自动暂存，刷新或重新打开可恢复。';
  $('#local-draft-detail').textContent = pending
    ? `${pending.title || '未命名文稿'} · ${Array.from(pending.text).length.toLocaleString()} 字符 · ${formatRecordDate(pending.saved_at)}。恢复时会一并使用草稿中的资料选择${pending.source_id ? `（资料 #${pending.source_id}）` : ''}。`
    : damaged ? '当前编辑内容仍在。舍弃异常副本后，可以重新暂存。'
      : session?.external ? '另一页面已清理本机副本。点击“保留当前内容”可将本页编辑重新暂存。' : '';
  syncGuideUI();
}

function queueDraftSave() {
  if (!draftMatchesContext() || workspaceInitializing) return;
  clearTimeout(draftSaveTimer);
  draftSession.dirty = true;
  if (!draftSession.pending && draftSession.error !== 'invalid' && !draftSession.external) {
    draftSaveTimer = setTimeout(flushDraftSave, 500);
  }
  syncLocalDraftUI();
}

function draftOperationFailed(result) {
  draftSession.error = result.reason;
  draftSession.dirty = true;
  if (result.reason === 'invalid' && typeof result.raw === 'string') {
    draftSession.raw = result.raw;
    draftSession.pending = null;
  }
  if (result.reason === 'conflict') {
    const latest = draftStore.read(draftSession.reviewId);
    draftSession.raw = latest.raw ?? null;
    draftSession.pending = latest.ok ? latest.draft : null;
    draftSession.error = latest.ok ? 'conflict' : latest.reason;
    draftSession.external = true;
  }
  syncLocalDraftUI();
  return false;
}

function flushDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  if (!draftMatchesContext() || workspaceInitializing) return false;
  if (!draftSession.dirty) return isLocalDraftSaved();
  if (draftSession.pending || draftSession.error === 'invalid' || draftSession.external) return false;
  const snapshot = captureLocalDraft();
  const result = draftHasContent() ? draftStore.write(snapshot, draftSession.raw)
    : draftStore.remove(draftSession.reviewId, draftSession.raw);
  if (!result.ok) return draftOperationFailed(result);
  draftSession.raw = result.raw;
  draftSession.saved = result.draft;
  draftSession.savedAt = result.draft?.saved_at || null;
  draftSession.dirty = false;
  draftSession.error = null;
  syncLocalDraftUI();
  return true;
}

function clearLocalDraft() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  if (!draftMatchesContext()) return true;
  const result = draftStore.remove(draftSession.reviewId, draftSession.raw);
  if (!result.ok) return draftOperationFailed(result);
  Object.assign(draftSession, { raw: null, pending: null, saved: null, savedAt: null,
    dirty: false, error: null, external: false, opinionConflict: false });
  syncLocalDraftUI();
  return true;
}

function discardLocalDraft() {
  if (sentenceBusy() || !draftMatchesContext()) return;
  const message = draftSession.external
    ? '使用当前页面的内容替换另一页面暂存的草稿？已保存的审阅档案不受影响。'
    : '舍弃上次的本机草稿？当前页面的内容和已保存的审阅档案会保留。';
  if (!window.confirm(message) || !clearLocalDraft()) return;
  queueDraftSave();
  flushDraftSave();
}

function mergedDraftDecisions(draft) {
  if (!currentRecord) return [];
  if (draft.record_text !== currentRecord.normalized_text || draft.decisions.length !== currentRecord.decisions.length) return null;
  const same = (a, b) => a.state === b.state && a.note === b.note;
  const merged = [];
  for (let index = 0; index < draft.decisions.length; index += 1) {
    const original = draft.base_decisions[index];
    const local = draft.decisions[index];
    const saved = currentRecord.decisions[index];
    if (same(original, local) || same(saved, local)) merged.push({ ...saved });
    else if (same(original, saved)) merged.push({ ...local });
    else return null;
  }
  return merged;
}

function recoverLocalDraft(textOnly = false) {
  if (sentenceBusy() || !draftMatchesContext() || !draftSession.pending) return false;
  const draft = draftSession.pending;
  // Re-read before applying a choice, in case another tab changed it meanwhile.
  const latest = draftStore.read(draftSession.reviewId);
  if (!latest.ok) return draftOperationFailed(latest);
  if (latest.raw !== draftSession.raw) return draftOperationFailed({ reason: 'conflict' });
  if (currentRecord && draft.record_text !== currentRecord.normalized_text) {
    draftSession.error = 'invalid';
    syncLocalDraftUI();
    return false;
  }
  const decisions = mergedDraftDecisions(draft);
  if (decisions === null && !textOnly) {
    draftSession.opinionConflict = true;
    syncLocalDraftUI();
    return false;
  }
  if (draftHasContent() && !window.confirm('恢复上次草稿会替换当前页面的编辑内容，是否继续？')) return false;
  if (textOnly && !exportLocalDraft(draft)) return false;
  documentTitle.value = draft.title;
  documentPreview.value = draft.text;
  if (draft.source_id && !Array.from(sourceSelect.options).some(option => Number(option.value) === draft.source_id)) {
    const option = element('option', '', `草稿所用资料 #${draft.source_id}（当前不可用）`);
    option.value = String(draft.source_id);
    sourceSelect.append(option);
  }
  sourceSelect.value = draft.source_id ? String(draft.source_id) : '';
  activeSentenceIndex = null;
  currentSentenceMap = null;
  sentenceEditBase = '';
  sentenceEditConflict = false;
  sentenceInputHint = null;
  if (currentRecord) {
    localDecisions = textOnly ? currentRecord.decisions.map(item => ({ ...item })) : decisions;
    decisionSaveError = null;
    showReviewResult(currentRecord);
  }
  syncWorkspace();
  if (draft.sentence_edit && currentRecord) {
    const edit = draft.sentence_edit;
    activeSentenceIndex = edit.index;
    sentenceEditBase = edit.base;
    $('#sentence-editor').value = edit.text;
    const range = window.SentenceMap.locate(currentSentenceMap, edit.index);
    sentenceEditConflict = edit.conflict || !range || documentPreview.value.slice(range.start, range.end) !== edit.base;
    renderSentenceReference(currentRecord.results[edit.index]);
  }
  Object.assign(draftSession, { pending: null, opinionConflict: false, external: false, error: null, dirty: true });
  syncWorkspace();
  selectWorkspaceTab(0);
  flushDraftSave();
  workflowMessage(textOnly ? '已下载草稿备份并恢复文稿。人工意见采用档案中的最新保存值，请对照备份核对。'
    : '已恢复本机草稿。文稿修改仍需复核，恢复的人工意见仍需点击“保存”才会进入档案。');
  return true;
}

function exportLocalDraft(snapshot = null) {
  const draft = snapshot || (draftHasContent() ? captureLocalDraft() : draftSession?.pending) || captureLocalDraft();
  const lines = ['传统服饰说明核验 · 草稿备份', `标题：${draft.title || '未命名文稿'}`,
    `暂存时间：${draft.saved_at}`, `对应档案：${draft.review_id || '新文稿'}`,
    `资料编号：${draft.source_id || '未选择'}`, '', '【文稿正文】', draft.text];
  if (draft.sentence_edit) lines.push('', `【第 ${draft.sentence_edit.index + 1} 句尚未应用的输入】`, draft.sentence_edit.text);
  if (draft.decisions.length) {
    lines.push('', '【草稿中的人工意见（请与档案核对）】');
    draft.decisions.forEach(item => lines.push(`第 ${item.index + 1} 句：${DECISION_TITLES[item.state]}`, item.note || '无备注'));
  }
  try {
    const url = URL.createObjectURL(new Blob(['\uFEFF', lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = `${(draft.title || '未命名文稿').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-草稿备份.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    workflowMessage('备份下载未成功，请复制文稿和备注后再离开页面。', true);
    return false;
  }
}

function bindDraftEvents() {
  $('#recover-local-draft').addEventListener('click', () => recoverLocalDraft());
  $('#recover-draft-text').addEventListener('click', () => recoverLocalDraft(true));
  $('#discard-local-draft').addEventListener('click', discardLocalDraft);
  $('#export-local-draft').addEventListener('click', () => exportLocalDraft());
  $('#export-pending-draft').addEventListener('click', () => exportLocalDraft(draftSession?.pending));
  $('#retry-local-draft').addEventListener('click', () => {
    if (!draftSession) initializeDrafts();
    queueDraftSave();
    flushDraftSave();
  });
  window.addEventListener('pagehide', flushDraftSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDraftSave(); });
  window.addEventListener('storage', (event) => {
    if (!draftMatchesContext()) return;
    const rawKey = `cmit:workspace-draft:v1:${draftSession.reviewId ? `review:${draftSession.reviewId}` : 'new'}`;
    const key = window.Account ? window.Account.storageKey(rawKey) : rawKey;
    if (event.key !== null && event.key !== key) return;
    const latest = draftStore.read(draftSession.reviewId);
    if (!latest.ok || latest.raw !== draftSession.raw) draftOperationFailed(latest.ok ? { reason: 'conflict' } : latest);
  });
}

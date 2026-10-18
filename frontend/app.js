const REQUEST_TIMEOUT_MS = 120000;
// 整篇审阅逐句跑模型，比上传慢得多，单独放宽。
const REVIEW_TIMEOUT_MS = 600000;
const START_HELP = '请在项目目录运行 python -m backend.serve，再通过服务地址打开页面。';

const $ = (selector) => document.querySelector(selector);

/* ---------- 元素引用 ---------- */

const documentFile = $('#document-file');
const documentImport = $('#document-import');
const chooseDocumentButton = $('#choose-document');
const manualEntryButton = $('#manual-entry');
const documentTitle = $('#document-title');
const documentStatus = $('#document-status');
const documentPreviewBox = $('#document-preview-box');
const documentPreview = $('#document-preview');
const sourceSelect = $('#source-select');
const sourceHelp = $('#source-help');
const reviewButton = $('#review-document');
const reviewProgressBox = $('#review-progress-box');
const scanList = $('#scan-list');
const scanCount = $('#scan-count');
const scanTotal = $('#scan-total');
const progressFill = $('#progress-fill');
const reviewResultBox = $('#review-result-box');
const reviewResult = $('#review-result');
const reviewStatus = $('#review-status');
const previewEmpty = $('#preview-empty');
const reviewEmpty = $('#review-empty');
const workspaceStatus = $('#workspace-status');
const reviewHint = $('#review-hint');
const workspaceTabs = [$('#preview-tab'), $('#results-tab')];
const workspaceViews = [$('#preview-view'), $('#results-view')];

let activeUpload = null;
let activeReview = null;
let reviewState = 'idle';
let currentRecord = null;
let localDecisions = [];
let activeHistory = null;
let activeSave = null;
let activeDecisionSaveIndexes = new Set();
let decisionSaveError = null;
let activeReport = null;
let activeSourceSelection = false;
let availableSourceIds = new Set();
let currentSentenceMap = null;
let sentenceMapRecordId = null;
let activeSentenceIndex = null;
let sentenceEditBase = '';
let sentenceEditConflict = false;
let sentenceInputHint = null;
let workspaceInitializing = true;
let reviewDraftCheckpoint = null;
let manualEntryExpanded = false;
let resultModelFilter = 'all';
let resultDecisionFilter = 'all';
let resultCompactView = false;
let resultNavigationIndex = null;
let resultRetainedIndex = null;
let resultExpandedCards = new Set();
let resultControls = null;
let resultCardViews = new Map();
const DECISION_TITLES = { unreviewed: '未处理', confirmed: '确认有误', dismissed: '保留原句', pending: '待补证' };
const DECISION_FILTER_TITLES = { all: '全部', unreviewed: '未处理', pending: '待补证', completed: '已完成' };
const RECORD_ID = /^[a-f0-9]{32}$/;

/* ---------- 小工具 ---------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selectWorkspaceTab(index, focus = false) {
  workspaceTabs.forEach((tab, tabIndex) => {
    const selected = tabIndex === index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    workspaceViews[tabIndex].hidden = !selected;
  });
  if (focus) workspaceTabs[index].focus();
}

function syncWorkspace() {
  syncSentenceMapping();
  const hasDocument = Boolean(documentPreview.value.trim());
  const busy = sentenceBusy();
  const sentenceDirty = hasSentenceEdit();
  const changed = hasDraftChanges();
  sourceSelect.disabled = busy || availableSourceIds.size === 0;
  sourcePicker?.sync();
  documentPreview.readOnly = busy || sentenceDirty;
  documentTitle.disabled = busy;
  documentFile.disabled = busy;
  chooseDocumentButton.disabled = busy;
  manualEntryButton.disabled = busy;
  $('#clear-button').disabled = busy;
  $('#restore-draft').disabled = busy;
  reviewButton.disabled = busy || sentenceDirty || !hasDocument || !availableSourceIds.has(Number(sourceSelect.value));
  const sourceLink = $('#selected-source-link');
  sourceLink.hidden = !availableSourceIds.has(Number(sourceSelect.value));
  if (!sourceLink.hidden) sourceLink.href = `./source.html?id=${Number(sourceSelect.value)}`;
  syncDocumentEntry(hasDocument);
  reviewEmpty.hidden = !reviewProgressBox.hidden || !reviewResultBox.hidden;
  reviewProgressBox.setAttribute('aria-busy', String(Boolean(activeReview)));
  $('#document-count').textContent = `${Array.from(documentPreview.value).length.toLocaleString()} / 50,000 字符`;
  $('#draft-state').hidden = !currentRecord;
  $('#draft-status').textContent = changed ? '正文或审阅设置已修改，尚未复核。修改会作为新版本保留。' : '正文与当前审阅记录一致，可继续编辑后复核。';
  $('#restore-draft').hidden = !changed;
  $('#stale-result-notice').hidden = !currentRecord || !changed;
  if (!activeReview) $('#review-button-label').textContent = currentRecord ? '修改后复核' : '整篇审阅';
  document.querySelectorAll('.decision-control').forEach((input) => { input.disabled = busy; });
  syncDecisions();
  syncSentenceFocus();
  syncLocalDraftUI();

  if (activeUpload) {
    workspaceStatus.textContent = '正在提取文字';
    reviewHint.textContent = '正在读取文稿，请稍候。';
  } else if (activeReview) {
    workspaceStatus.textContent = '正在审阅';
    reviewHint.textContent = '正在逐句对照资料，请稍候。';
  } else if (activeHistory) {
    workspaceStatus.textContent = '正在打开记录';
    reviewHint.textContent = '正在读取留档原文与处理记录。';
  } else if (activeSave) {
    workspaceStatus.textContent = '正在保存人工处理';
    reviewHint.textContent = '保存完成后可以继续修改或复核。';
  } else if (activeSourceSelection) {
    workspaceStatus.textContent = '正在选择资料';
    reviewHint.textContent = '正在打开资料馆中所选资料，请稍候。';
  } else {
    workspaceStatus.textContent = sentenceDirty ? '单句输入待应用' : currentRecord && changed ? '修改后待复核'
      : reviewState === 'completed' ? '审阅已留档'
      : reviewState === 'error' ? '审阅未完成'
      : hasDocument ? '文稿已就绪' : '准备新文稿';
    reviewHint.textContent = sentenceDirty ? '请先应用或撤销单句输入，再进行复核。' : !hasDocument ? '上传 Word 或 PDF 文稿，选择资料后即可开始。'
      : sourceSelect.disabled ? '请先连接可用资料库。'
      : !availableSourceIds.has(Number(sourceSelect.value)) ? '请选择一份备用资料，供全库未匹配时使用，再开始审阅。'
      : currentRecord ? '复核将生成新版本，并保留本版记录。'
      : '已准备就绪，审阅完成后自动留档。';
  }
  syncGuideUI();
}

function hasDraftChanges() {
  return Boolean(currentRecord && (documentPreview.value !== currentRecord.normalized_text
    || documentTitle.value.trim() !== currentRecord.title
    || Number(sourceSelect.value) !== currentRecord.source_id));
}

function decisionsDirty() {
  return Boolean(currentRecord && !sameDecisions(localDecisions, currentRecord.decisions));
}

function sameDecisions(left, right) {
  return left.length === right.length && left.every((decision, index) =>
    decision.index === right[index].index && decision.state === right[index].state && decision.note === right[index].note);
}

function workflowMessage(message, error = false) {
  $('#retry-history').hidden = true;
  $('#workflow-notice').hidden = !message;
  $('#workflow-notice').classList.toggle('is-error', error);
  $('#workflow-status').textContent = message;
}

function guardUnsavedDecisions() {
  if (!guardSentenceEdit()) return false;
  if (activeSave) return false;
  if (!decisionsDirty()) return true;
  workflowMessage('人工处理尚未保存。请先保存，或点击「撤销未保存处理」，再执行此操作。', true);
  selectWorkspaceTab(1);
  $('#save-decisions').focus();
  return false;
}

/* ---------- 结果定位与单句改稿 ---------- */

function sentenceBusy() {
  return Boolean(workspaceInitializing || activeUpload || activeReview || activeHistory || activeSave || activeSourceSelection || activeExampleLoad);
}

function hasSentenceEdit() {
  return activeSentenceIndex !== null && $('#sentence-editor').value !== sentenceEditBase;
}

function guardSentenceEdit() {
  if (!hasSentenceEdit()) return true;
  workflowMessage('这句还有未应用的输入。请先「应用到正文」或「撤销本次输入」，再继续。', true);
  selectWorkspaceTab(0);
  $('#sentence-editor').focus({ preventScroll: true });
  $('#sentence-focus').scrollIntoView({ block: 'start', behavior: 'auto' });
  return false;
}

function syncSentenceMapping() {
  if (!currentRecord) {
    currentSentenceMap = null;
    sentenceMapRecordId = null;
    activeSentenceIndex = null;
    sentenceEditBase = '';
    sentenceEditConflict = false;
    sentenceInputHint = null;
    return;
  }
  if (!currentSentenceMap || sentenceMapRecordId !== currentRecord.review_id) {
    currentSentenceMap = window.SentenceMap.create(currentRecord.normalized_text, currentRecord.results);
    sentenceMapRecordId = currentRecord.review_id;
  }
  if (currentSentenceMap.text !== documentPreview.value) {
    const dirty = hasSentenceEdit();
    currentSentenceMap = window.SentenceMap.update(currentSentenceMap, documentPreview.value, sentenceInputHint);
    if (dirty) sentenceEditConflict = true;
    else if (activeSentenceIndex !== null) {
      const range = window.SentenceMap.locate(currentSentenceMap, activeSentenceIndex);
      sentenceEditBase = range ? documentPreview.value.slice(range.start, range.end) : '';
      $('#sentence-editor').value = sentenceEditBase;
    }
  }
  sentenceInputHint = null;
}

function sentenceStateLabel(range) {
  return !range || range.status === 'unavailable' ? '位置已变化 · 请复核'
    : range.status === 'edited' ? '已修改 · 待复核' : '与本版原句一致';
}

function syncSentenceFocus() {
  const busy = sentenceBusy();
  const ranges = new Map((currentSentenceMap?.ranges || []).map(range => [range.index, range]));
  for (const result of currentRecord?.results || []) {
    const candidate = ranges.get(result.index);
    const range = candidate?.status === 'unavailable' ? null : candidate;
    const badge = $(`#sentence-edit-state-${result.index}`);
    if (badge) {
      badge.textContent = sentenceStateLabel(range);
      badge.dataset.state = !range ? 'unavailable' : range.status === 'edited' ? 'modified' : 'unchanged';
    }
    const button = $(`#locate-sentence-${result.index}`);
    if (button) {
      button.disabled = busy;
      button.textContent = range ? '定位并修改' : '查看原句与依据';
      button.setAttribute('aria-label', range ? `定位并修改第 ${result.index + 1} 句` : `查看第 ${result.index + 1} 句的原句与依据`);
    }
    const card = $(`#sentence-result-${result.index}`);
    if (card) card.classList.toggle('is-active-result', result.index === activeSentenceIndex);
  }
  $('#sentence-focus').hidden = !currentRecord || activeSentenceIndex === null;
  if (!currentRecord || activeSentenceIndex === null) return;
  const result = currentRecord.results[activeSentenceIndex];
  const range = window.SentenceMap.locate(currentSentenceMap, activeSentenceIndex);
  const dirty = hasSentenceEdit();
  $('#sentence-focus-title').textContent = `定位改稿 · 第 ${activeSentenceIndex + 1} 句`;
  $('#sentence-focus-state').textContent = dirty ? '输入待应用' : sentenceStateLabel(range);
  $('#sentence-focus-state').dataset.state = dirty || range?.status === 'edited' ? 'modified' : 'unchanged';
  $('#sentence-focus-message').textContent = sentenceEditConflict
    ? '正文已在输入期间变化。为避免替换错位置，请先撤销本次输入，再核对正文。'
    : !range ? '正文位置已变化，无法可靠定位。请在下方全文编辑后复核，原句与依据仍可查看。'
      : dirty ? '输入尚未应用到正文。应用后再复核，原有判定和人工意见会保留在本版记录中。'
        : range.status === 'edited' ? '已更新正文，尚未复核。下方保留的是修改前的判定与证据。'
          : '已高亮当前正文中的对应位置。可结合本版证据修改这一句，再应用到正文。';
  const context = $('#sentence-context');
  context.replaceChildren();
  if (range) {
    const before = Array.from(documentPreview.value.slice(0, range.start));
    const after = Array.from(documentPreview.value.slice(range.end));
    context.append(document.createTextNode(`${before.length > 100 ? '…' : ''}${before.slice(-100).join('')}`),
      element('mark', 'sentence-context-mark', documentPreview.value.slice(range.start, range.end)),
      document.createTextNode(`${after.slice(0, 100).join('')}${after.length > 100 ? '…' : ''}`));
  } else context.append(element('p', '', '当前正文中的对应位置待重新审阅确认。'));
  $('#sentence-editor').readOnly = busy || !range || sentenceEditConflict;
  $('#apply-sentence-edit').disabled = busy || !range || sentenceEditConflict || !dirty;
  $('#cancel-sentence-edit').disabled = busy || (!dirty && !sentenceEditConflict);
  $('#previous-sentence').disabled = busy || dirty || activeSentenceIndex === 0;
  $('#next-sentence').disabled = busy || dirty || activeSentenceIndex >= currentRecord.results.length - 1;
  $('#return-to-result').disabled = busy;
}

function renderSentenceReference(result) {
  $('#sentence-original').textContent = `本版原句：${result.sentence}`;
  const container = $('#sentence-evidence');
  container.replaceChildren(element('p', 'result-message', `本版判定：${SENTENCE_TITLES[result.status]}。${result.message}`));
  result.evidence.forEach((evidence) => {
    const block = element('div', 'evidence-full');
    block.append(element('p', 'problem-label', `${evidence.object_name || '资料对象未标注'} · ${EVIDENCE_TITLES[evidence.stance]}`),
      element('blockquote', '', evidence.evidence));
    const source = element('p', 'problem-source', '来源：');
    source.append(sourceLink(evidence.source_url, evidence.source_title || '资料'));
    if (evidence.locator) source.append(document.createTextNode(` · ${evidence.locator}`));
    block.append(source);
    container.append(block);
  });
  if (!result.evidence.length) container.append(element('p', 'no-evidence-note', '本句没有参与比对的证据，需要另找依据。'));
}

function locateSentence(index) {
  if (sentenceBusy() || !currentRecord || !Number.isInteger(index) || !currentRecord.results[index]) return;
  if (index !== activeSentenceIndex && !guardSentenceEdit()) return;
  syncSentenceMapping();
  const samePending = index === activeSentenceIndex && hasSentenceEdit();
  activeSentenceIndex = index;
  const range = window.SentenceMap.locate(currentSentenceMap, index);
  if (!samePending) {
    sentenceEditBase = range ? documentPreview.value.slice(range.start, range.end) : '';
    $('#sentence-editor').value = sentenceEditBase;
    sentenceEditConflict = false;
  }
  renderSentenceReference(currentRecord.results[index]);
  selectWorkspaceTab(0);
  syncWorkspace();
  if (range) documentPreview.setSelectionRange(range.start, range.end);
  $('#sentence-focus-title').focus({ preventScroll: true });
  $('#sentence-focus').scrollIntoView({ block: 'start', behavior: 'auto' });
}

function applySentenceEdit() {
  if (sentenceBusy() || activeSentenceIndex === null || !hasSentenceEdit()) return;
  syncSentenceMapping();
  const range = window.SentenceMap.locate(currentSentenceMap, activeSentenceIndex);
  if (!range || sentenceEditConflict || documentPreview.value.slice(range.start, range.end) !== sentenceEditBase) {
    sentenceEditConflict = true;
    syncWorkspace();
    return;
  }
  const replacement = $('#sentence-editor').value;
  const text = documentPreview.value.slice(0, range.start) + replacement + documentPreview.value.slice(range.end);
  if (Array.from(text).length > 50000) {
    $('#sentence-focus-message').textContent = '应用后正文超过 50,000 字符，请缩短本句内容。';
    return;
  }
  currentSentenceMap = window.SentenceMap.update(currentSentenceMap, text, {
    start: range.start, end: range.end, sentenceIndex: activeSentenceIndex,
  });
  documentPreview.value = text;
  sentenceInputHint = null;
  sentenceEditBase = replacement;
  sentenceEditConflict = false;
  syncWorkspace();
  queueDraftSave();
  workflowMessage('本句修改已应用到正文，尚未复核。点击「修改后复核」生成新版本，本版原句、判定和人工意见会保留。');
}

function cancelSentenceEdit() {
  if (sentenceBusy() || activeSentenceIndex === null) return;
  syncSentenceMapping();
  const range = window.SentenceMap.locate(currentSentenceMap, activeSentenceIndex);
  sentenceEditBase = range ? documentPreview.value.slice(range.start, range.end) : '';
  $('#sentence-editor').value = sentenceEditBase;
  sentenceEditConflict = false;
  workflowMessage('');
  syncWorkspace();
  queueDraftSave();
}

function returnToSentenceResult() {
  if (sentenceBusy() || activeSentenceIndex === null) return;
  selectWorkspaceTab(1);
  const card = $(`#sentence-result-${activeSentenceIndex}`);
  if (!card) return;
  if (card.hidden) {
    if (resultModelFilter !== 'all' && card.dataset.status !== resultModelFilter) resultModelFilter = 'all';
    if (!matchesDecisionFilter(localDecisions[activeSentenceIndex]?.state)) resultDecisionFilter = 'all';
    resultRetainedIndex = null;
    syncResultControls();
  }
  resultNavigationIndex = activeSentenceIndex;
  setResultCardExpanded(activeSentenceIndex, true);
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function guardLeavingDraft() {
  if (!guardUnsavedDecisions()) return false;
  const hasUnreviewedText = currentRecord ? hasDraftChanges() : Boolean(documentPreview.value.trim());
  return !hasUnreviewedText || window.confirm('当前文稿有尚未复核的修改。继续将放弃这些文稿修改，已留档的审阅记录会保留。');
}

/* ---------- 长文连续处理 ---------- */
let resultLayoutObserver = null;

function observeResultToolbarLayout(top) {
  resultLayoutObserver?.disconnect();
  if (typeof ResizeObserver !== 'function') return;
  const header = document.querySelector('.site-header');
  const readingScroll = document.querySelector('.reading-scroll');
  if (!header || !readingScroll) return;
  const measure = () => {
    // Hidden tabs measure zero; retain the last useful offsets until visible.
    const headerHeight = header.getBoundingClientRect().height;
    const toolbarHeight = top.getBoundingClientRect().height;
    if (headerHeight > 0) readingScroll.style.setProperty('--review-header-height', `${Math.ceil(headerHeight)}px`);
    if (toolbarHeight > 0) readingScroll.style.setProperty('--review-toolbar-height', `${Math.ceil(toolbarHeight)}px`);
  };
  resultLayoutObserver = new ResizeObserver(measure);
  resultLayoutObserver.observe(header);
  resultLayoutObserver.observe(top);
}

function resetResultControls() {
  resultLayoutObserver?.disconnect();
  resultLayoutObserver = null;
  if (resultControls) {
    resultControls.toolbar.hidden = true;
    resultControls.next.disabled = true;
  }
  resultModelFilter = 'all';
  resultDecisionFilter = 'all';
  resultCompactView = false;
  resultNavigationIndex = null;
  resultRetainedIndex = null;
  resultExpandedCards = new Set();
  resultControls = null;
  resultCardViews = new Map();
}

function matchesDecisionFilter(state) {
  return resultDecisionFilter === 'all'
    || (resultDecisionFilter === 'completed' ? ['confirmed', 'dismissed'].includes(state) : state === resultDecisionFilter);
}

function setResultCardExpanded(index, expanded) {
  const view = resultCardViews.get(index);
  if (!view) return;
  if (expanded) resultExpandedCards.add(index);
  else resultExpandedCards.delete(index);
  view.details.hidden = resultCompactView && !expanded;
  view.toggle.hidden = !resultCompactView;
  view.toggle.setAttribute('aria-expanded', String(!view.details.hidden));
  view.toggle.textContent = view.details.hidden ? '展开证据与处理' : '收起详情';
  view.card.classList.toggle('is-compact', view.details.hidden);
}

function applyResultFilters() {
  if (!resultControls || !currentRecord) return;
  let visible = 0;
  let retained = 0;
  const visibleGroups = new Map(RESULT_GROUPS.map(([status]) => [status, 0]));
  resultCardViews.forEach((view, index) => {
    const modelMatches = resultModelFilter === 'all' || view.card.dataset.status === resultModelFilter;
    const decisionMatches = matchesDecisionFilter(localDecisions[index]?.state);
    const keepCurrent = index === resultRetainedIndex && !decisionMatches;
    view.card.hidden = !modelMatches || (!decisionMatches && !keepCurrent);
    if (!view.card.hidden) {
      visible += 1;
      if (keepCurrent) retained += 1;
      visibleGroups.set(view.card.dataset.status, visibleGroups.get(view.card.dataset.status) + 1);
    }
  });
  resultControls.groups.forEach(({ group, count }, status) => {
    const groupCount = visibleGroups.get(status);
    group.hidden = groupCount === 0;
    count.textContent = `${groupCount} 句`;
  });
  resultControls.modelButtons.forEach((button, status) => button.setAttribute('aria-pressed', String(status === resultModelFilter)));
  resultControls.decisionButtons.forEach((button, state) => button.setAttribute('aria-pressed', String(state === resultDecisionFilter)));
  const labels = [];
  if (resultModelFilter !== 'all') labels.push(SENTENCE_TITLES[resultModelFilter]);
  if (resultDecisionFilter !== 'all') labels.push(DECISION_FILTER_TITLES[resultDecisionFilter]);
  resultControls.filterCount.textContent = visible
    ? `${labels.length ? `当前筛选「${labels.join(' · ')}」` : '显示全部'} ${visible} 句。${RESULT_ORDER_HELP}${retained ? '当前句处理状态已变化，暂留至切换筛选或跳转下一句。' : ''}`
    : labels.length ? `没有同时符合「${labels.join(' · ')}」的句子，可切换筛选继续查看。` : '本版没有可审阅的正文句子。';
  resultControls.empty.hidden = visible > 0 || currentRecord.results.length === 0;
}

function unreviewedResultOrder() {
  if (!currentRecord) return [];
  const ranks = new Map(RESULT_GROUPS.map(([status], index) => [status, index]));
  return currentRecord.results.filter(result => resultModelFilter === 'all' || result.status === resultModelFilter)
    .slice().sort((left, right) => ranks.get(left.status) - ranks.get(right.status) || left.index - right.index);
}

function navigateNextUnreviewed() {
  if (sentenceBusy() || !currentRecord || !guardSentenceEdit()) return;
  const ordered = unreviewedResultOrder();
  const cursor = ordered.findIndex(result => result.index === resultNavigationIndex);
  const remaining = ordered.slice(cursor + 1).concat(ordered.slice(0, cursor + 1));
  const next = remaining.find(result => localDecisions[result.index].state === 'unreviewed');
  if (!next) {
    if (resultControls) resultControls.navigationStatus.textContent = localDecisions.some(decision => decision.state === 'unreviewed')
      ? '当前模型判定筛选内没有未处理句子，请切换模型筛选。' : '没有未处理句子；待补证项仍需继续核对。';
    return;
  }
  resultNavigationIndex = next.index;
  resultRetainedIndex = null;
  resultDecisionFilter = 'unreviewed';
  applyResultFilters();
  setResultCardExpanded(next.index, true);
  selectWorkspaceTab(1);
  const card = resultCardViews.get(next.index)?.card;
  if (card) {
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  const wrapped = cursor >= 0 && ordered.findIndex(result => result.index === next.index) <= cursor;
  resultControls.navigationStatus.textContent = `${wrapped ? '已回到当前列表前部。' : ''}已定位第 ${next.index + 1} 句，请核对证据后填写人工意见。`;
}

function syncResultControls() {
  if (!resultControls || !currentRecord) return;
  const counts = { unreviewed: 0, pending: 0, completed: 0, all: localDecisions.length };
  localDecisions.forEach(decision => { counts[['confirmed', 'dismissed'].includes(decision.state) ? 'completed' : decision.state] += 1; });
  const outstanding = counts.unreviewed + counts.pending;
  const dirty = decisionsDirty();
  resultControls.progress.textContent = `共 ${counts.all} 句 · 已完成 ${counts.completed} 句 · 待处理 ${outstanding} 句`;
  resultControls.progressNote.textContent = `未处理 ${counts.unreviewed} · 待补证 ${counts.pending}${dirty ? ' · 含未保存意见，请保存后留档。' : ' · 已完成仅计确认有误或保留原句。'}`;
  resultControls.meter.max = Math.max(counts.all, 1);
  resultControls.meter.value = counts.completed;
  resultControls.meter.setAttribute('aria-valuetext', `共 ${counts.all} 句，已完成 ${counts.completed} 句，待补证 ${counts.pending} 句`);
  const busy = sentenceBusy();
  const available = unreviewedResultOrder().filter(result => localDecisions[result.index].state === 'unreviewed').length;
  resultControls.next.disabled = busy || available === 0;
  resultControls.next.textContent = available ? '下一条未处理' : resultModelFilter === 'all' ? '暂无未处理句子' : '此筛选无未处理';
  resultControls.compact.disabled = busy || counts.all === 0;
  resultControls.compact.checked = resultCompactView;
  resultControls.decisionButtons.forEach((button, state) => {
    button.textContent = `${DECISION_FILTER_TITLES[state]} ${counts[state]}`;
    button.disabled = busy;
  });
  resultControls.modelButtons.forEach(button => { button.disabled = busy; });
  resultCardViews.forEach((view, index) => {
    view.badge.textContent = `人工：${DECISION_TITLES[localDecisions[index].state]}`;
    view.badge.dataset.state = localDecisions[index].state;
    view.toggle.disabled = busy;
    setResultCardExpanded(index, resultExpandedCards.has(index));
  });
  applyResultFilters();
}

function createResultToolbar() {
  const toolbar = element('section', 'result-toolbar');
  toolbar.id = 'review-processing-toolbar';
  toolbar.setAttribute('aria-label', '逐句处理进度与导航');
  const top = element('div', 'result-toolbar-top');
  const progressBox = element('div', 'result-progress');
  const progress = element('strong', 'result-progress-text');
  progress.id = 'review-processing-progress';
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-atomic', 'true');
  const meter = element('progress', 'result-progress-meter');
  meter.id = 'review-processing-meter';
  meter.setAttribute('aria-label', '人工处理完成进度');
  const progressNote = element('p', 'result-progress-note');
  progressNote.id = 'review-processing-note';
  progressBox.append(progress, meter, progressNote);
  const actions = element('div', 'result-toolbar-actions');
  const next = element('button', 'primary-button next-unreviewed');
  next.id = 'next-unreviewed';
  next.type = 'button';
  next.setAttribute('aria-describedby', 'review-navigation-status');
  next.addEventListener('click', navigateNextUnreviewed);
  const compactLabel = element('label', 'result-compact-control');
  const compact = element('input');
  compact.id = 'review-view-compact';
  compact.type = 'checkbox';
  compact.checked = resultCompactView;
  compact.addEventListener('change', () => {
    if (sentenceBusy()) { compact.checked = resultCompactView; return; }
    resultCompactView = compact.checked;
    resultExpandedCards.clear();
    syncResultControls();
  });
  compactLabel.append(compact, element('span', '', '紧凑视图'));
  actions.append(next, compactLabel);
  top.append(progressBox, actions);
  const decisionFilters = element('div', 'decision-filters');
  decisionFilters.setAttribute('role', 'group');
  decisionFilters.setAttribute('aria-label', '按人工处理状态筛选句子');
  decisionFilters.append(element('span', 'result-filter-label', '人工处理'));
  const decisionButtons = new Map();
  Object.entries(DECISION_FILTER_TITLES).forEach(([state, title]) => {
    const button = element('button', 'result-filter decision-filter', title);
    button.id = `decision-filter-${state}`;
    button.type = 'button';
    button.dataset.state = state;
    button.setAttribute('aria-pressed', String(state === resultDecisionFilter));
    button.addEventListener('click', () => {
      if (sentenceBusy()) return;
      resultDecisionFilter = state;
      resultRetainedIndex = null;
      resultControls.navigationStatus.textContent = '';
      applyResultFilters();
    });
    decisionButtons.set(state, button);
    decisionFilters.append(button);
  });
  const navigationStatus = element('p', 'review-navigation-status');
  navigationStatus.id = 'review-navigation-status';
  navigationStatus.setAttribute('role', 'status');
  navigationStatus.setAttribute('aria-atomic', 'true');
  const filterCount = element('p', 'filter-count');
  filterCount.id = 'result-filter-count';
  filterCount.setAttribute('role', 'status');
  const empty = element('p', 'result-filter-empty', '当前筛选下没有句子，可选择“全部”或其他处理状态。');
  empty.hidden = true;
  toolbar.append(top, decisionFilters, navigationStatus);
  resultControls = { toolbar, progress, progressNote, meter, next, compact, decisionButtons, navigationStatus, filterCount, empty, groups: new Map(), modelButtons: new Map() };
  observeResultToolbarLayout(top);
  return toolbar;
}

function syncDecisions() {
  const dirty = decisionsDirty();
  const busy = Boolean(activeSave || activeHistory || activeUpload || activeReview || activeSourceSelection);
  $('#save-decisions').disabled = !currentRecord || !dirty || busy;
  $('#save-decisions').textContent = activeSave ? '正在保存…' : '保存全部人工处理';
  $('#export-report').disabled = !currentRecord || dirty || busy || Boolean(activeReport);
  $('#export-report').textContent = activeReport ? '正在导出…' : '导出本版报告';
  $('#discard-decisions').hidden = !dirty;
  $('#discard-decisions').disabled = busy;
  if (!currentRecord) return;
  const counts = Object.fromEntries(Object.keys(DECISION_TITLES).map((key) => [key, 0]));
  localDecisions.forEach((decision) => { counts[decision.state] += 1; });
  $('#decision-summary').textContent = `未处理 ${counts.unreviewed} · 确认有误 ${counts.confirmed} · 保留 ${counts.dismissed} · 待补证 ${counts.pending}`;
  $('#decision-save-status').textContent = activeSave ? '正在保存本版人工处理，请稍候。'
    : dirty ? '有未保存的人工处理。可在句子下方保存本句，或在此保存全部。'
    : !localDecisions.length ? '本版没有正文结果，无需逐句处理。'
      : currentRecord.decisions_revision === 0 ? '初始记录已留档，尚未人工处理。'
        : '人工处理已保存，可导出本版报告。';
  localDecisions.forEach((decision, index) => {
    const button = $(`#save-decision-${index}`);
    const status = $(`#decision-save-status-${index}`);
    if (!button || !status) return;
    const saved = currentRecord.decisions[index];
    const changed = decision.state !== saved.state || decision.note !== saved.note;
    const saving = Boolean(activeSave && activeDecisionSaveIndexes.has(index));
    const error = changed && decisionSaveError?.recordId === currentRecord.review_id
      && decisionSaveError.indexes.has(index) ? decisionSaveError.message : '';
    const hasSavedOpinion = saved.state !== 'unreviewed' || Boolean(saved.note) || currentRecord.decisions_revision > 0;
    button.disabled = !changed || busy;
    button.textContent = saving ? '正在保存…' : '保存';
    status.dataset.state = saving ? 'saving' : error ? 'error' : changed ? 'dirty' : hasSavedOpinion ? 'saved' : 'unchanged';
    status.textContent = saving ? '正在保存本句，请稍候…'
      : error ? error
        : changed ? '未保存 · 点击左侧按钮保存本句意见和备注。'
          : hasSavedOpinion ? saved.state === 'unreviewed' && !saved.note
            ? '当前状态已保存 · 本句尚未人工处理。' : '已保存至本次审阅档案'
            : '尚未填写 · 填写后请保存本句。';
  });
  syncResultControls();
}

// 服务状态指示：页头那颗小圆点。
function setServiceState(state, text) {
  const dot = $('#service-dot');
  dot.className = `status-dot ${state}${state === 'ready' ? ' pulse' : ''}`;
  $('#service-text').textContent = text;
}

function sourceLink(url, title) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return element('span', '', title);
    const link = element('a', '', title);
    link.href = parsed.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch {
    return element('span', '', title);
  }
}

async function requestJSON(path, options = {}) {
  if (window.location.protocol === 'file:') throw new Error(START_HELP);
  const response = await (window.Account?.fetch || fetch)(path, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    if ([404, 405, 501].includes(response.status)) throw new Error(`当前服务尚不支持此操作，请重启项目服务后重试。${START_HELP}`);
    throw new Error(`服务没有返回有效数据。${START_HELP}`);
  }
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('服务返回的内容无法读取，请稍后重试。');
  }
  if (!response.ok) {
    const error = new Error(typeof data?.error === 'string' ? data.error : `服务暂时不可用（${response.status}），请稍后重试。`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ---------- 资料列表 ---------- */

async function loadSources() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const data = await requestJSON('/api/sources', { signal: controller.signal });
    if (!data || !Number.isInteger(data.approved_count) || data.approved_count < 0 || !Array.isArray(data.sources)
      || data.sources.some((source) => !source || !Number.isInteger(source.id)
        || typeof source.title !== 'string' || typeof source.object_name !== 'string')) {
      throw new Error('资料列表格式不正确，请刷新页面重试。');
    }
    data.sources.forEach((source) => {
      const option = Array.from(sourceSelect.options).find((item) => Number(item.value) === source.id) || element('option');
      option.textContent = source.object_name && source.object_name !== source.title
        ? `${source.object_name} · ${source.title}` : source.title;
      option.value = String(source.id);
      if (!option.parentElement) sourceSelect.append(option);
    });
    availableSourceIds = new Set(data.sources.map((source) => source.id));
    sourcePicker?.setSources(data.sources);
    guideSourceMatches = data.sources.filter(source => source.title === GUIDE_EXAMPLE.sourceTitle
      && source.object_name === GUIDE_EXAMPLE.sourceTitle).map(source => source.id);
    sourceSelect.disabled = data.sources.length === 0;
    sourceHelp.textContent = data.approved_count > 0
      ? `当前有 ${data.approved_count} 条已审核证据，来自 ${data.sources.length} 份资料。`
      : '尚无已审核证据。资料审核通过后，刷新页面即可检索。';
    setServiceState(
      data.sources.length ? 'ready' : 'offline',
      data.sources.length ? `资料库就绪 · ${data.approved_count} 条证据` : '资料库为空'
    );
    return true;
  } catch (error) {
    guideSourceMatches = [];
    sourceHelp.textContent = controller.signal.aborted ? '读取资料列表超时，请刷新页面重试。'
      : error instanceof TypeError ? `无法连接服务。${START_HELP}` : error.message;
    setServiceState('offline', '服务未连接');
    return false;
  } finally {
    clearTimeout(timeout);
    syncWorkspace();
  }
}

/* ---------- 文档上传 ---------- */

function syncDocumentEntry(hasDocument) {
  // Keep an editor open while the user deletes or rewrites its last characters.
  if (documentPreview.value) manualEntryExpanded = true;
  documentImport.dataset.hasDocument = String(hasDocument);
  documentImport.setAttribute('aria-busy', String(Boolean(activeUpload)));
  chooseDocumentButton.textContent = hasDocument ? '更换文件' : '选择 Word 文件';
  documentPreviewBox.hidden = !manualEntryExpanded;
  previewEmpty.hidden = manualEntryExpanded;
  manualEntryButton.hidden = Boolean(documentPreview.value);
  manualEntryButton.setAttribute('aria-expanded', String(manualEntryExpanded));
  manualEntryButton.textContent = manualEntryExpanded ? '收起手动输入' : '手动输入或粘贴文本';
}

function toggleManualEntry() {
  if (sentenceBusy()) return;
  manualEntryExpanded = Boolean(documentPreview.value) || !manualEntryExpanded;
  selectWorkspaceTab(0);
  syncWorkspace();
  if (manualEntryExpanded) documentPreview.focus();
}

function resetDocumentUpload() {
  if (activeUpload) activeUpload.abort();
  activeUpload = null;

  documentPreview.value = '';
  documentTitle.value = '';
  manualEntryExpanded = false;
  documentFile.value = '';
  documentStatus.textContent = '';
  $('#document-count').textContent = '';
  selectWorkspaceTab(0);
  syncWorkspace();
}

async function handleDocumentChange() {
  if (sentenceBusy()) return;
  const file = documentFile.files[0];
  documentFile.value = ''; // 允许再次选择同一个文件重试。
  if (!file) return;
  if (draftSession?.pending || draftSession?.external || draftSession?.error === 'invalid') {
    documentStatus.textContent = '请先在「本机草稿」中选择恢复或舍弃旧草稿，再导入文件。';
    return;
  }
  if (!guardLeavingDraft()) return;

  const kind = file.name.split('.').pop().toLowerCase();

  if (!['pdf', 'docx'].includes(kind)) {
    documentStatus.textContent = '仅支持 .pdf 和 .docx；.doc 请先另存为 .docx。';
    return;
  }

  if (!file.size || file.size > 10 * 1024 * 1024) {
    documentStatus.textContent = '请选择非空且不超过 10 MB 的文件。';
    return;
  }

  const controller = new AbortController();
  activeUpload = controller;

  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  documentStatus.textContent = `正在读取：${file.name}…`;
  syncWorkspace();

  try {
    const data = await requestJSON('/api/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Document-Type': kind,
      },
      body: file,
      signal: controller.signal,
    });

    // 清空或重新选择文件后，忽略旧请求的响应。
    if (activeUpload !== controller) return;

    if (typeof data?.text !== 'string' || !data.text.trim()) {
      throw new Error('服务未返回有效文字。');
    }

    // Keep the existing document and its backup until extraction has succeeded.
    if (draftSession?.pending || draftSession?.external || draftSession?.error === 'invalid' || !clearLocalDraft()) {
      documentStatus.textContent = '已提取文字，请先处理本机草稿冲突，再重新导入。原文稿仍在。';
      return;
    }
    resetReview();
    initializeDrafts();
    documentPreview.value = data.text;
    documentTitle.value = file.name.replace(/\.(pdf|docx)$/i, '').slice(0, 120);
    selectWorkspaceTab(0);
    $('#document-count').textContent = `${data.text.length} 字符`;
    documentStatus.textContent = `已读取：${file.name}。${data.warning || ''}`;
    queueDraftSave();

  } catch (error) {
    if (activeUpload !== controller) return;

    documentStatus.textContent = controller.signal.aborted
      ? '读取超时，请重新选择文件。'
      : error instanceof TypeError
        ? `无法连接服务。${START_HELP}`
        : error.message;

  } finally {
    clearTimeout(timeout);

    if (activeUpload === controller) {
      activeUpload = null;
      syncWorkspace();
    }
  }
}

/* ---------- 逐句比对：进度区 ----------

   为什么需要缓冲播放：
   模型首次推理要 4 秒预热，之后每句只要约 70 毫秒。若收到就立刻渲染，
   26 句会在不到 2 秒内闪完，动画糊成一片，反而看不清。
   所以把收到的结果先排队，按可读的节奏逐条播出——真实进度不丢，
   但观众能看清每一句的状态。 */

const SENTENCE_TITLES = {
  supported: '模型判为支持',
  refute: '疑似矛盾',
  insufficient: '证据不足',
  conflicting: '判定分歧',
  uncovered: '未覆盖',
};
const EVIDENCE_TITLES = { supports: '模型判为支持', refutes: '模型判为反驳', insufficient: '模型判为信息不足' };
const STATUS_COUNT_FIELDS = {
  supported: 'supported_sentences',
  refute: 'refuted_sentences',
  insufficient: 'insufficient_sentences',
  conflicting: 'conflicting_sentences',
  uncovered: 'uncovered_sentences',
};
const RESULT_SCHEMA_HELP = '审阅接口版本不兼容。请重启后端服务（python -m backend.serve），再刷新页面重试。';
const RESULT_GROUPS = [
  ['refute', '模型判断与证据存在矛盾，请优先核对原文。'],
  ['conflicting', '同一句话的证据比对中，同时出现“支持”和“反驳”的模型判定，需人工核对。'],
  ['insufficient', '现有证据不足以支持或反驳，建议补充依据。'],
  ['supported', '模型判为支持，仍需核对对象和适用范围。'],
  ['uncovered', '未进入模型比对，需另找资料或补充对象信息。'],
];
const RESULT_ORDER_HELP = '按处理优先级分组，未覆盖置于最后；组内保留原文句序。';

// 每句停留时长。实测真实处理约 70ms/句，这里放慢到可读的速度。
const PLAYBACK_INTERVAL_MS = 130;

let playQueue = [];
let playTimer = null;
let pendingDone = null;
let warmupOn = null;

// 预热状态：模型首次推理要几秒，这段时间一条结果都没有。
// 与其让屏幕干等，不如明确告诉观众在等什么。
function setWarmup(active) {
  if (warmupOn === active) return;
  warmupOn = active;
  const box = $('#review-progress-box');
  const title = $('#review-progress-box .scan-title');
  if (box) box.dataset.warmup = active ? 'on' : 'off';
  if (title) title.textContent = active ? '正在载入模型' : '正在逐句比对';
}

function buildScanList(total) {
  scanList.replaceChildren();
  for (let index = 0; index < total; index += 1) {
    const item = element('li');
    item.dataset.state = 'pending';
    item.append(
      element('span', 'n', String(index + 1)),
      element('span', 't', ''),
      element('span', 'mark', '')
    );
    // 逐条错开出现，避免整列一次性闪出。
    item.style.animationDelay = `${Math.min(index * 26, 900)}ms`;
    item.classList.add('row-in');
    scanList.append(item);
  }
  scanCount.textContent = '0';
  scanTotal.textContent = String(total);
  progressFill.style.width = '0%';
  progressFill.parentElement.setAttribute('aria-valuenow', '0');
}

function paintRow(index, sentence, status) {
  const row = scanList.children[index];
  if (!row) return;
  const text = row.querySelector('.t');
  if (text.textContent !== sentence) text.textContent = sentence;

  // 先亮起「正在比对」，下一帧落到终态，让扫过的动作看得见。
  row.dataset.state = 'active';
  requestAnimationFrame(() => {
    row.dataset.state = status;
    row.querySelector('.mark').textContent = SENTENCE_TITLES[status] || '';
  });

  const total = Number(scanTotal.textContent) || 1;
  scanCount.textContent = String(index + 1);
  const percentage = Math.min(100, ((index + 1) / total) * 100);
  progressFill.style.width = `${percentage}%`;
  progressFill.parentElement.setAttribute('aria-valuenow', String(percentage));

  // 让当前行保持可见。
  const top = row.offsetTop;
  const view = scanList.scrollTop;
  if (top < view || top > view + scanList.clientHeight - 40) {
    scanList.scrollTop = Math.max(0, top - scanList.clientHeight / 2);
  }
}

function startPlayback(controller) {
  if (playTimer) clearInterval(playTimer);
  playTimer = setInterval(() => {
    if (activeReview !== controller) {
      clearInterval(playTimer);
      playTimer = null;
      return;
    }

    const next = playQueue.shift();
    if (next) {
      paintRow(next.index, next.sentence, next.status);
      return;
    }

    // 队列暂时为空：可能是预热阶段（结果尚未到达），也可能是全部播完。
    // 只有结果已经到达，才能结束；否则继续等，不能提前揭晓。
    if (pendingDone) {
      clearInterval(playTimer);
      playTimer = null;
      finishReview(controller);
    }
  }, PLAYBACK_INTERVAL_MS);
}

/* 释放审阅状态并复原按钮。
   注意：这一步不能在请求结束时就做。逐句动画是异步播放的，比请求活得久；
   若请求一结束就把 activeReview 清空，播放循环下一跳会以为自己已失效而退出，
   动画停在半途、结果永不显示。所以由动画播完的那一刻来调用它。 */
function releaseReview(controller) {
  if (activeReview !== controller) return;
  activeReview = null;
  reviewButton.classList.remove('busy');
  $('#review-button-label').textContent = '整篇审阅';
  syncWorkspace();
}

function finishReview(controller) {
  if (activeReview !== controller || !pendingDone) return;
  const data = pendingDone;
  pendingDone = null;
  reviewProgressBox.hidden = true;
  // Consume the submitted working copy only after a validated review exists.
  if (reviewDraftCheckpoint) draftStore.remove(reviewDraftCheckpoint.reviewId, reviewDraftCheckpoint.raw);
  reviewDraftCheckpoint = null;
  adoptRecord(data);
  workflowMessage('审阅已自动留档。对读证据后，可逐句填写人工意见并保存。');
  if (!workspaceViews[1].hidden) {
    reviewResultBox.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }
  releaseReview(controller);
  initializeDrafts();
}

/* ---------- 整篇审阅 ---------- */

function resetReview() {
  if (activeReview) activeReview.abort();
  activeReview = null;
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  playQueue = [];
  pendingDone = null;
  warmupOn = null;
  reviewState = 'idle';
  currentRecord = null;
  resetResultControls();
  decisionSaveError = null;
  activeDecisionSaveIndexes = new Set();
  syncRecordAddress(null);
  localDecisions = [];
  $('#record-heading').hidden = true;
  $('#decision-workbench').hidden = true;
  workflowMessage('');

  reviewProgressBox.hidden = true;
  reviewResultBox.hidden = true;
  scanList.replaceChildren();
  reviewResult.replaceChildren();
  reviewStatus.textContent = '';
  $('#review-badge').textContent = '';
  progressFill.style.width = '0%';
  progressFill.parentElement.setAttribute('aria-valuenow', '0');
  reviewButton.classList.remove('busy');
  $('#review-button-label').textContent = '整篇审阅';
  selectWorkspaceTab(0);
  syncWorkspace();
}

function validateDoneEvent(data) {
  if (data?.schema_version !== 2) throw new Error(RESULT_SCHEMA_HELP);
  const fail = () => { throw new Error('审阅结果不完整或计数不一致，请重新审阅；如仍出现此提示，请重启后端服务。'); };
  const { stats, results } = data;
  const integer = (value) => Number.isInteger(value) && value >= 0;
  const countFields = ['total_sentences', 'checked_sentences', 'problems_found',
    ...Object.values(STATUS_COUNT_FIELDS), 'no_evidence_sentences', 'low_relevance_sentences', 'noise_sentences'];
  if (!stats || !Array.isArray(results) || countFields.some((key) => !integer(stats[key]))
    || results.length !== stats.total_sentences) fail();

  const counts = Object.fromEntries(Object.keys(SENTENCE_TITLES).map((status) => [status, 0]));
  let previousEnd = 0;
  let noEvidence = 0;
  let lowRelevance = 0;
  results.forEach((item, index) => {
    if (!item || item.index !== index || typeof item.sentence !== 'string' || !item.sentence.trim()
      || !Object.hasOwn(SENTENCE_TITLES, item.status)
      || !integer(item.sentence_start) || !integer(item.sentence_end)
      || item.sentence_start < previousEnd || item.sentence_end <= item.sentence_start
      || typeof item.reason !== 'string' || typeof item.message !== 'string'
      || !Array.isArray(item.evidence)) fail();
    previousEnd = item.sentence_end;
    counts[item.status] += 1;
    const stances = new Set();
    for (const evidence of item.evidence) {
      if (!evidence || !integer(evidence.evidence_id) || !integer(evidence.source_id)
        || typeof evidence.evidence !== 'string' || !evidence.evidence.trim()
        || typeof evidence.object_name !== 'string' || typeof evidence.source_title !== 'string'
        || (evidence.source_url !== null && typeof evidence.source_url !== 'string')
        || (evidence.locator !== null && typeof evidence.locator !== 'string')
        || !Object.hasOwn(EVIDENCE_TITLES, evidence.stance)
        || !evidence.scores || Object.keys(EVIDENCE_TITLES).some((key) =>
          !Number.isFinite(evidence.scores[key]) || evidence.scores[key] < 0 || evidence.scores[key] > 1)
        || !Number.isFinite(evidence.relevance) || evidence.relevance < 0) fail();
      stances.add(evidence.stance);
    }
    const expectedStatus = !stances.size ? 'uncovered'
      : stances.has('supports') && stances.has('refutes') ? 'conflicting'
      : stances.has('refutes') ? 'refute'
      : stances.has('supports') ? 'supported' : 'insufficient';
    if (item.status !== expectedStatus) fail();
    if (item.status === 'uncovered') {
      if (item.reason === 'no_evidence') noEvidence += 1;
      else if (item.reason === 'low_relevance') lowRelevance += 1;
      else fail();
    } else if (['no_evidence', 'low_relevance'].includes(item.reason)) fail();
  });
  for (const [status, field] of Object.entries(STATUS_COUNT_FIELDS)) {
    if (stats[field] !== counts[status]) fail();
  }
  if (stats.checked_sentences !== results.length - counts.uncovered
    || stats.problems_found !== counts.refute
    || stats.no_evidence_sentences !== noEvidence
    || stats.low_relevance_sentences !== lowRelevance) fail();
  const expectedCoverage = results.length ? stats.checked_sentences / results.length : null;
  if (expectedCoverage === null ? stats.coverage_ratio !== null
    : !Number.isFinite(stats.coverage_ratio) || Math.abs(stats.coverage_ratio - expectedCoverage) > 0.000001) fail();
  if (typeof data.normalized_text !== 'string' || data.offset_basis !== 'normalized_text_python_chars') fail();
  const characters = Array.from(data.normalized_text);
  if (results.some((item) => characters.slice(item.sentence_start, item.sentence_end).join('') !== item.sentence)) fail();
  validateRecordMetadata(data);
  return data;
}

function validateRecordMetadata(data) {
  if (!data || !RECORD_ID.test(data.review_id) || typeof data.title !== 'string' || Array.from(data.title).length > 120
    || !Number.isInteger(data.source_id) || data.source_id <= 0
    || (data.parent_id !== null && !RECORD_ID.test(data.parent_id))
    || typeof data.created_at !== 'string' || !Number.isFinite(Date.parse(data.created_at))
    || typeof data.model_version !== 'string'
    || !Number.isInteger(data.decisions_revision) || data.decisions_revision < 0) {
    throw new Error('审阅留档数据不完整。请重启后端服务并刷新页面，再尝试打开记录。');
  }
  if (!Array.isArray(data.decisions) || data.decisions.length !== data.results.length
    || data.decisions.some((decision, index) => !decision || decision.index !== index
      || !Object.hasOwn(DECISION_TITLES, decision.state) || typeof decision.note !== 'string')) {
    throw new Error('人工处理数据不完整，请重新打开记录。');
  }
}

function restoreRecordDraft() {
  if (!currentRecord) return;
  currentSentenceMap = window.SentenceMap.create(currentRecord.normalized_text, currentRecord.results);
  sentenceMapRecordId = currentRecord.review_id;
  activeSentenceIndex = null;
  sentenceEditBase = '';
  sentenceEditConflict = false;
  sentenceInputHint = null;
  documentPreview.value = currentRecord.normalized_text;
  documentTitle.value = currentRecord.title;
  if (!Array.from(sourceSelect.options).some((option) => Number(option.value) === currentRecord.source_id)) {
    const option = element('option', '', `历史记录所用资料 #${currentRecord.source_id}（当前不可用）`);
    option.value = String(currentRecord.source_id);
    sourceSelect.append(option);
  }
  sourceSelect.value = String(currentRecord.source_id);
  documentStatus.textContent = '已恢复本版留档原文，可继续修改。';
  syncWorkspace();
}

function formatRecordDate(date) {
  return new Date(date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function adoptRecord(data) {
  if (currentRecord?.review_id !== data.review_id) resetResultControls();
  currentRecord = data;
  decisionSaveError = null;
  activeDecisionSaveIndexes = new Set();
  syncRecordAddress(data.review_id);
  localDecisions = data.decisions.map((decision) => ({ ...decision }));
  restoreRecordDraft();
  showReviewResult(data);
  syncWorkspace();
  if (!workspaceInitializing && !activeHistory && !activeReview) initializeDrafts();
}

function showReviewResult(data) {
  const { stats, results } = data;
  reviewState = 'completed';
  reviewResultBox.hidden = false;
  reviewResult.replaceChildren();
  resultCardViews = new Map();
  $('#record-heading').hidden = false;
  $('#decision-workbench').hidden = false;
  $('#result-heading').textContent = data.title || '未命名文稿';
  $('#record-meta').textContent = `${formatRecordDate(data.created_at)} 留档 · ${data.parent_id ? `源自记录 ${data.parent_id.slice(0, 8)} 的复核版本` : '初次审阅'} · 记录 ${data.review_id.slice(0, 8)}`;
  const pendingCount = stats.insufficient_sentences + stats.conflicting_sentences + stats.uncovered_sentences;
  $('#review-badge').textContent = `${stats.refuted_sentences} 句疑似矛盾 · ${pendingCount} 句待核`;

  // 模型覆盖率只描述处理范围，不能作为正确率或稿件合格率。
  const summary = element('div', 'review-summary');
  const entries = [
    ['正文句数', stats.total_sentences, false],
    ['送入模型比对', stats.checked_sentences, false],
    ['模型比对覆盖率', stats.coverage_ratio === null ? '—' : `${(stats.coverage_ratio * 100).toFixed(1)}%`, false],
  ];
  for (const [label, value, bad] of entries) {
    const stat = element('div', `review-stat${bad && value > 0 ? ' bad' : ''}`);
    stat.append(element('strong', '', String(value)), element('span', '', label));
    summary.append(stat);
  }
  reviewResult.append(summary, element('p', 'coverage-note',
    '覆盖率 = 实际送入模型比对的正文句数 ÷ 正文总句数，不代表正确率。所有结论均为模型预测，请结合原文人工核对。'));
  if (stats.noise_sentences) {
    reviewResult.append(element('p', 'coverage-note', `另有 ${stats.noise_sentences} 个标题或短片段被过滤，未计入正文句数和覆盖率。`));
  }
  if (stats.uncovered_sentences) {
    reviewResult.append(element('p', 'coverage-note',
      `未覆盖 ${stats.uncovered_sentences} 句：未检索到证据 ${stats.no_evidence_sentences} 句，候选文字相关性不足 ${stats.low_relevance_sentences} 句。`));
  }
  const toolbar = createResultToolbar();
  reviewResult.append(toolbar);

  if (!results.length) {
    reviewStatus.textContent = '没有可审阅的正文句子，未执行模型比对，也未形成核验结论。';
    $('#review-badge').textContent = '没有正文结果';
    syncResultControls();
    return;
  }
  reviewStatus.textContent = stats.checked_sentences === 0
    ? '本次正文全部未覆盖，没有句子送入模型比对，不能判断稿件是否准确。'
    : stats.refuted_sentences || stats.conflicting_sentences
      ? `本次有 ${stats.refuted_sentences} 句疑似矛盾、${stats.conflicting_sentences} 句判定分歧，请优先人工核对。`
      : pendingCount
        ? `本次未检出疑似矛盾，但仍有 ${pendingCount} 句证据不足或未覆盖，需要人工补核。`
        : '本次所有正文句均被模型判为支持；模型可能误判，请继续核对证据与适用范围。';

  const filters = element('div', 'result-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', '按模型判定筛选句子');
  filters.append(element('span', 'result-filter-label', '模型判定'));
  const list = element('div', 'result-list');
  const groups = new Map();
  RESULT_GROUPS.forEach(([status, description]) => {
    const count = stats[STATUS_COUNT_FIELDS[status]];
    if (!count) return;
    const group = element('section', 'result-group');
    group.id = `result-group-${status}`;
    group.dataset.status = status;
    const heading = element('div', 'result-group-heading');
    const title = element('h3', '', SENTENCE_TITLES[status]);
    title.id = `result-group-title-${status}`;
    group.setAttribute('aria-labelledby', title.id);
    const countLabel = element('span', 'result-group-count', `${count} 句`);
    heading.append(title, countLabel);
    const contents = element('div', 'result-group-list');
    group.append(heading, element('p', 'result-group-copy', description), contents);
    groups.set(status, { group, contents, count: countLabel });
    list.append(group);
  });
  results.forEach((result, index) => {
    const card = element('article', 'problem-card result-card');
    card.id = `sentence-result-${result.index}`;
    card.tabIndex = -1;
    card.dataset.status = result.status;
    card.addEventListener('focusin', () => { resultNavigationIndex = result.index; });
    card.addEventListener('click', () => { resultNavigationIndex = result.index; });
    card.style.animationDelay = `${Math.min(index * 30, 300)}ms`;
    const heading = element('div', 'result-card-heading');
    const decisionBadge = element('span', 'result-decision-badge');
    decisionBadge.id = `result-decision-badge-${result.index}`;
    heading.append(element('span', 'sentence-number', `第 ${result.index + 1} 句`),
      element('span', 'problem-tag', SENTENCE_TITLES[result.status]), decisionBadge);
    const editState = element('span', 'sentence-edit-state');
    editState.id = `sentence-edit-state-${result.index}`;
    const locate = element('button', 'sentence-locate', '定位并修改');
    locate.id = `locate-sentence-${result.index}`;
    locate.type = 'button';
    locate.setAttribute('aria-label', `定位并修改第 ${result.index + 1} 句`);
    locate.addEventListener('click', () => locateSentence(result.index));
    heading.append(editState, locate);
    const detailToggle = element('button', 'text-button result-details-toggle', '展开证据与处理');
    detailToggle.id = `toggle-result-details-${result.index}`;
    detailToggle.type = 'button';
    detailToggle.setAttribute('aria-controls', `result-details-${result.index}`);
    detailToggle.setAttribute('aria-label', `展开或收起第 ${result.index + 1} 句的证据与人工处理`);
    detailToggle.addEventListener('click', () => {
      if (sentenceBusy()) return;
      resultNavigationIndex = result.index;
      setResultCardExpanded(result.index, !resultExpandedCards.has(result.index));
    });
    const detailsBody = element('div', 'result-details');
    detailsBody.id = `result-details-${result.index}`;
    detailsBody.append(element('p', 'result-message', result.message));
    card.append(heading, element('p', 'problem-claim', result.sentence), detailToggle, detailsBody);
    if (['refute', 'supported'].includes(result.status) && result.evidence.length) {
      const details = element('details', 'evidence-details');
      // 列表仅展开红、绿两类的原文；完整证据仍保留在记录和单句详情中。
      details.open = true;
      details.append(element('summary', '', `资料原文与出处 · ${result.evidence.length} 条`));
      result.evidence.forEach((evidence) => {
        const evidenceBlock = element('div', 'evidence-full');
        evidenceBlock.append(element('p', 'problem-label',
          `${evidence.object_name || '资料对象未标注'} · ${EVIDENCE_TITLES[evidence.stance]}`),
        element('blockquote', '', evidence.evidence));
        const source = element('p', 'problem-source', '来源：');
        source.append(sourceLink(evidence.source_url, evidence.source_title || '资料'));
        if (evidence.locator) source.append(document.createTextNode(` · ${evidence.locator}`));
        evidenceBlock.append(source);
        details.append(evidenceBlock);
      });
      detailsBody.append(details);
    } else if (result.status === 'uncovered') {
      detailsBody.append(element('p', 'no-evidence-note', '本句未进入模型比对，暂无用于判定的证据原文。'));
    }
    const decisionBox = element('div', 'sentence-decision');
    const decisionHeading = element('div', 'decision-field-heading');
    const stateLabel = element('label', '', '人工意见');
    stateLabel.htmlFor = `decision-state-${result.index}`;
    const stateSelect = element('select', 'decision-control');
    stateSelect.id = stateLabel.htmlFor;
    Object.entries(DECISION_TITLES).forEach(([value, title]) => {
      const option = element('option', '', title);
      option.value = value;
      stateSelect.append(option);
    });
    stateSelect.value = localDecisions[result.index].state;
    stateSelect.addEventListener('change', () => {
      localDecisions[result.index].state = stateSelect.value;
      resultNavigationIndex = result.index;
      if (!matchesDecisionFilter(stateSelect.value)) resultRetainedIndex = result.index;
      decisionBox.dataset.state = stateSelect.value;
      syncDecisions();
      queueDraftSave();
    });
    decisionHeading.append(stateLabel, stateSelect);
    const noteLabel = element('label', 'decision-note-label', '核对备注');
    noteLabel.htmlFor = `decision-note-${result.index}`;
    const note = element('textarea', 'decision-control decision-note');
    note.id = noteLabel.htmlFor;
    note.rows = 2;
    note.maxLength = 2000;
    note.placeholder = '记录依据、修改建议或需要补充的资料（选填）';
    note.value = localDecisions[result.index].note;
    note.addEventListener('input', () => {
      localDecisions[result.index].note = note.value;
      resultNavigationIndex = result.index;
      syncDecisions();
      queueDraftSave();
    });
    decisionBox.dataset.state = stateSelect.value;
    const saveActions = element('div', 'sentence-save-actions');
    const saveButton = element('button', 'secondary-button sentence-save-button', '保存');
    saveButton.id = `save-decision-${result.index}`;
    saveButton.type = 'button';
    saveButton.disabled = true;
    saveButton.setAttribute('aria-label', `保存第 ${result.index + 1} 句的人工意见和备注`);
    saveButton.setAttribute('aria-describedby', `decision-save-status-${result.index}`);
    saveButton.addEventListener('click', () => saveDecisions(result.index));
    const saveStatus = element('p', 'sentence-save-status');
    saveStatus.id = `decision-save-status-${result.index}`;
    saveStatus.setAttribute('role', 'status');
    saveStatus.setAttribute('aria-atomic', 'true');
    saveActions.append(saveButton, saveStatus);
    decisionBox.append(decisionHeading, noteLabel, note, saveActions);
    detailsBody.append(decisionBox);
    groups.get(result.status).contents.append(card);
    resultCardViews.set(result.index, { card, details: detailsBody, toggle: detailToggle, badge: decisionBadge });
  });
  const filtersToShow = [['all', `全部 ${results.length}`], ...RESULT_GROUPS
    .map(([status]) => [status, `${SENTENCE_TITLES[status]} ${stats[STATUS_COUNT_FIELDS[status]]}`])];
  resultControls.groups = groups;
  filtersToShow.forEach(([status, label]) => {
    const button = element('button', 'result-filter', label);
    button.type = 'button';
    button.id = `result-filter-${status}`;
    button.dataset.status = status;
    button.setAttribute('aria-pressed', String(status === resultModelFilter));
    button.addEventListener('click', () => {
      if (sentenceBusy()) return;
      resultModelFilter = status;
      resultRetainedIndex = null;
      resultControls.navigationStatus.textContent = '';
      syncResultControls();
    });
    resultControls.modelButtons.set(status, button);
    filters.append(button);
  });
  reviewResult.append(filters, resultControls.filterCount, resultControls.empty, list);
  syncResultControls();
}

/* 流式读取 NDJSON：每收到一行就更新一次界面。
   这是「真实进度」的关键——等待时间不再是空转，而是把逐句比对演出来。 */
async function readReviewStream(response, controller) {
  if (!response.body) throw new Error('当前浏览器不支持流式读取，请更换浏览器。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let total = null;
  const received = [];
  let doneData = null;

  const handle = (payload) => {
    if (!payload || doneData) throw new Error('审阅进度顺序不正确，请重新审阅。');
    if (payload.type === 'start') {
      if (total !== null || !Number.isInteger(payload.total) || payload.total < 0) {
        throw new Error('审阅进度格式不正确，请重新审阅。');
      }
      total = payload.total;
      // 总数一到就先把列表建出来，并进入预热状态。
      buildScanList(payload.total);
      setWarmup(true);
    } else if (payload.type === 'sentence') {
      if (['pass', 'skipped'].includes(payload.status)) throw new Error(RESULT_SCHEMA_HELP);
      if (total === null || payload.total !== total || payload.index !== received.length
        || payload.index >= total || typeof payload.sentence !== 'string'
        || !Object.hasOwn(SENTENCE_TITLES, payload.status)) {
        throw new Error('审阅进度格式不正确，请重新审阅。');
      }
      // 收到即入队，由播放定时器按可读节奏播出。
      setWarmup(false);
      received.push(payload);
      playQueue.push({
        index: payload.index,
        sentence: payload.sentence,
        status: payload.status,
      });
    } else if (payload.type === 'done') {
      doneData = validateDoneEvent(payload);
      if (total === null || total !== doneData.stats.total_sentences || received.length !== total
        || received.some((item, index) => item.sentence !== doneData.results[index].sentence
          || item.status !== doneData.results[index].status)) {
        throw new Error('审阅进度与最终结果不一致，请重新审阅。');
      }
    } else if (payload.type === 'error') {
      throw new Error(typeof payload.error === 'string' ? payload.error : '审阅失败。');
    } else throw new Error('审阅进度类型不正确，请重启后端后重试。');
  };

  while (true) {
    const { value, done: finished } = await reader.read();
    if (activeReview !== controller) return null;
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });

    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) handle(JSON.parse(line));
    }
  }

  const tail = (buffer + decoder.decode()).trim();
  if (tail) handle(JSON.parse(tail));

  // 流读完了，但结果要等播放队列播完才揭晓（见 finishReview）。
  if (!doneData) throw new Error('审阅没有返回完整结果。');
  pendingDone = doneData;
  return true;
}

async function handleReviewClick() {
  if (sentenceBusy() || !guardUnsavedDecisions()) return;
  if (draftSession?.pending || draftSession?.external || draftSession?.error === 'invalid') {
    workflowMessage('请先在「本机草稿」中选择恢复或舍弃旧草稿，再开始审阅。', true);
    return;
  }

  const text = documentPreview.value.trim();
  if (!text) {
    documentStatus.textContent = '请先粘贴或导入文稿正文。';
    return;
  }
  if (sourceSelect.disabled || !availableSourceIds.has(Number(sourceSelect.value))) {
    documentStatus.textContent = '请先选择一份备用资料，供全库未匹配时使用，再开始整篇审阅。';
    focusSourcePicker();
    return;
  }

  queueDraftSave();
  const draftSaved = flushDraftSave();
  if (draftSession?.pending || draftSession?.external || draftSession?.error === 'invalid') {
    workflowMessage('本机草稿刚在其他页面发生变化，请先处理草稿提示后再开始审阅。', true);
    return;
  }
  reviewDraftCheckpoint = draftSaved && draftMatchesContext() ? { reviewId: draftSession.reviewId, raw: draftSession.raw } : null;
  const controller = new AbortController();
  const reviewBody = {
    text, source_id: Number(sourceSelect.value),
    title: documentTitle.value.trim() || '未命名文稿',
    ...(currentRecord ? { parent_id: currentRecord.review_id } : {}),
  };
  activeReview = controller;
  workflowMessage('');
  reviewState = 'idle';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REVIEW_TIMEOUT_MS);

  reviewButton.disabled = true;
  reviewButton.classList.add('busy');
  $('#review-button-label').textContent = '正在逐句比对…';
  reviewResultBox.hidden = true;
  reviewResult.replaceChildren();
  reviewStatus.textContent = '';
  $('#review-badge').textContent = '';
  reviewProgressBox.hidden = false;
  scanList.replaceChildren();
  playQueue = [];
  pendingDone = null;
  warmupOn = null;
  setWarmup(true);
  startPlayback(controller);
  selectWorkspaceTab(1);
  syncWorkspace();

  try {
    const response = await (window.Account?.fetch || fetch)('/api/review', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 声明接受 NDJSON 时后端才走流式；否则退回一次性 JSON。
        'Accept': 'application/x-ndjson',
      },
      body: JSON.stringify(reviewBody),
      signal: controller.signal,
    });

    if (activeReview !== controller) return;

    if (!response.ok) {
      let message = `审阅服务暂时不可用（${response.status}）。`;
      try {
        const payload = await response.json();
        if (typeof payload?.error === 'string') message = payload.error;
      } catch { /* 保持默认提示 */ }
      throw new Error(message);
    }

    // 流读完不代表界面该揭晓：结果早已到达，但逐句动画可能还在播。
    // 揭晓交给播放队列（finishReview），避免动画被结果盖掉。
    if (response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      const data = validateDoneEvent(await response.json());
      if (activeReview !== controller) return;
      buildScanList(data.stats.total_sentences);
      setWarmup(false);
      playQueue = data.results.map(({ index, sentence, status }) => ({ index, sentence, status }));
      pendingDone = data;
    } else if (response.headers.get('content-type')?.toLowerCase().includes('application/x-ndjson')) {
      const streamed = await readReviewStream(response, controller);
      if (activeReview !== controller || !streamed) return;
    } else throw new Error(`审阅服务没有返回有效数据。${START_HELP}`);

    // 极短文稿时分句可能一句都没有，此时播放队列永远不会启动收尾。
    if (!playTimer) finishReview(controller);

  } catch (error) {
    if (activeReview !== controller) return;
    const message = timedOut ? '审阅等待超过 10 分钟，请缩短文稿后重试。'
      : error instanceof TypeError ? `无法连接服务。${START_HELP}` : error.message;
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    playQueue = [];
    pendingDone = null;
    reviewProgressBox.hidden = true;
    if (currentRecord) showReviewResult(currentRecord);
    else {
      reviewResultBox.hidden = false;
      reviewResult.replaceChildren();
      reviewStatus.textContent = message;
    }
    workflowMessage(`${message}${currentRecord ? ' 已保留此前的审阅记录和本次文稿修改。' : ''}`, true);
    reviewState = 'error';
    releaseReview(controller);

  } finally {
    // 只清理定时器。释放审阅状态交给 releaseReview：
    // 正常路径下要等逐句动画播完（finishReview 调用），
    // 异常路径下上面已经释放过了。
    clearTimeout(timeout);
  }
}

/* ---------- 审阅档案与人工复核 ---------- */

function syncRecordAddress(reviewId) {
  if (window.location.protocol === 'file:') return;
  const address = new URL(window.location.href);
  address.searchParams.delete('source');
  if (reviewId) address.searchParams.set('review', reviewId);
  else address.searchParams.delete('review');
  window.history.replaceState(null, '', address.href);
}

async function openHistory(reviewId) {
  if (!RECORD_ID.test(reviewId)) {
    workflowMessage('审阅记录地址无效，请从「审阅档案」重新选择记录。', true);
    return;
  }
  if (activeReview || activeUpload || activeHistory || activeSave || activeSourceSelection || !guardLeavingDraft()) return;
  const controller = new AbortController();
  activeHistory = controller;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  workflowMessage('正在读取审阅记录…');
  syncWorkspace();
  try {
    const data = validateDoneEvent(await requestJSON(`/api/reviews/${reviewId}`, { signal: controller.signal }));
    if (activeHistory !== controller) return;
    if (data.review_id !== reviewId) throw new Error('返回的记录与所选档案不一致，请重试。');
    adoptRecord(data);
    selectWorkspaceTab(1);
    workflowMessage('已打开留档记录。可继续保存人工意见，或编辑文稿后生成复核版本。');
  } catch (error) {
    if (activeHistory !== controller) return;
    workflowMessage(controller.signal.aborted ? '读取审阅记录超时，请重试。'
      : error instanceof TypeError ? '无法连接服务，当前文稿与处理意见已保留。' : error.message, true);
    $('#retry-history').hidden = false;
  } finally {
    clearTimeout(timeout);
    if (activeHistory === controller) {
      activeHistory = null;
      syncWorkspace();
      if (!workspaceInitializing && currentRecord?.review_id === reviewId) initializeDrafts();
    }
  }
}

async function saveDecisions(sentenceIndex = null) {
  if (!currentRecord || !decisionsDirty() || activeSave || activeReview || activeHistory || activeUpload || activeSourceSelection) return;
  if (sentenceIndex !== null && (!Number.isInteger(sentenceIndex) || sentenceIndex < 0 || sentenceIndex >= localDecisions.length)) return;
  const indexes = new Set(localDecisions.filter((decision) => {
    const saved = currentRecord.decisions[decision.index];
    return (sentenceIndex === null || decision.index === sentenceIndex)
      && (decision.state !== saved.state || decision.note !== saved.note);
  }).map((decision) => decision.index));
  if (!indexes.size) return;
  const controller = new AbortController();
  activeSave = controller;
  activeDecisionSaveIndexes = indexes;
  decisionSaveError = null;
  const recordId = currentRecord.review_id;
  const expectedRevision = currentRecord.decisions_revision;
  // 接口仍提交完整列表；单句保存只替换目标，其余使用已保存值。
  const decisions = currentRecord.decisions.map((decision) => ({
    ...(indexes.has(decision.index) ? localDecisions[decision.index] : decision),
  }));
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  workflowMessage('');
  syncWorkspace();
  try {
    const data = validateDoneEvent(await requestJSON(`/api/reviews/${recordId}/decisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ expected_revision: expectedRevision, decisions }),
    }));
    if (activeSave !== controller || currentRecord?.review_id !== recordId) return;
    if (data.review_id !== recordId || data.decisions_revision !== expectedRevision + 1
      || !sameDecisions(data.decisions, decisions)) {
      throw new Error('保存返回的内容与提交不一致，本地意见已保留，请重新打开档案确认。');
    }
    // 保存人工意见不覆盖尚未复核的编辑文稿，也不更改模型结论。
    currentRecord = data;
    localDecisions = localDecisions.map((decision) => indexes.has(decision.index)
      && sameDecisions([decision], [decisions[decision.index]]) ? { ...data.decisions[decision.index] } : decision);
    queueDraftSave();
    flushDraftSave();
    workflowMessage(sentenceIndex === null ? '人工处理已保存，已纳入本版报告。'
      : `第 ${sentenceIndex + 1} 句的人工意见和备注已保存。${decisionsDirty() ? '其他句子仍有未保存的修改。' : '可在审阅档案中查看。'}`);
  } catch (error) {
    if (activeSave !== controller || currentRecord?.review_id !== recordId) return;
    const message = error.status === 409
      ? '这条记录已在其他页面更新，保存未覆盖对方内容。你的本地意见仍在，请先复制需要保留的备注，再撤销未保存处理并从档案重新打开最新版。'
      : controller.signal.aborted ? '保存等待超时，本地意见仍在。请重新打开档案确认服务端是否已保存，避免重复提交。'
        : error instanceof TypeError ? '保存连接中断，本地意见仍在。请恢复连接后重试；若提示版本冲突，请重新打开档案确认。'
          : `保存未成功：${error.message}`;
    decisionSaveError = { recordId, indexes, message };
    workflowMessage(message, true);
  } finally {
    clearTimeout(timeout);
    if (activeSave === controller) {
      activeSave = null;
      activeDecisionSaveIndexes = new Set();
      syncWorkspace();
    }
  }
}

function discardDecisions() {
  if (!currentRecord || activeSave || !decisionsDirty()) return;
  if (!window.confirm('撤销当前未保存的人工意见与备注，恢复到最近一次已保存的处理状态？')) return;
  decisionSaveError = null;
  localDecisions = currentRecord.decisions.map((decision) => ({ ...decision }));
  showReviewResult(currentRecord);
  syncWorkspace();
  queueDraftSave();
  flushDraftSave();
  workflowMessage('已恢复最近一次保存的人工处理。');
}

async function exportReport() {
  if (!currentRecord || activeReport || activeReview || activeSave || activeHistory || !guardUnsavedDecisions()) return;
  const controller = new AbortController();
  activeReport = controller;
  const recordId = currentRecord.review_id;
  const title = currentRecord.title;
  const revision = currentRecord.decisions_revision;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  syncDecisions();
  try {
    const response = await (window.Account?.fetch || fetch)(`/api/reviews/${recordId}/report?revision=${revision}`, { signal: controller.signal });
    if (!response.ok) {
      let message = `报告导出失败（${response.status}），请重试。`;
      try {
        const data = await response.json();
        if (typeof data.error === 'string') message = data.error;
      } catch { /* 保持可读的默认提示 */ }
      throw new Error(message);
    }
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('报告格式不正确，请重试。');
    const blob = await response.blob();
    if (activeReport !== controller || currentRecord?.review_id !== recordId) return;
    if (currentRecord.decisions_revision !== revision || decisionsDirty()) {
      workflowMessage('导出期间人工意见发生变化。请保存并核对当前意见后重新导出，刚才的报告未下载。', true);
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = `${(title || '文稿审阅').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-${recordId.slice(0, 8)}-审阅报告.html`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    workflowMessage('本版报告已下载。打开 HTML 文件可查看完整证据，并使用浏览器打印为 PDF。');
  } catch (error) {
    if (activeReport !== controller || currentRecord?.review_id !== recordId) return;
    workflowMessage(controller.signal.aborted ? '导出报告超时，请重试。'
      : error instanceof TypeError ? '无法连接服务，报告尚未导出，请重试。' : error.message, true);
  } finally {
    clearTimeout(timeout);
    if (activeReport === controller) {
      activeReport = null;
      syncDecisions();
    }
  }
}

/* ---------- 清空 ---------- */

// 上传、预览、审阅结果一次复位。表单里的选择一并清掉。
function handleClear() {
  if (sentenceBusy() || !guardLeavingDraft()) return;
  if (draftSession?.pending && !window.confirm('清空内容也会舍弃当前记录对应的本机草稿，是否继续？')) return;
  if (!clearLocalDraft()) return;
  resetDocumentUpload();
  resetReview();
  documentFile.value = '';
  documentStatus.textContent = '';
  sourceSelect.value = '';
  guideExampleMessage = '';
  initializeDrafts();
  syncWorkspace();
}

/* ---------- 事件监听（统一在最后注册） ---------- */

documentFile.addEventListener('change', handleDocumentChange);
chooseDocumentButton.addEventListener('click', () => {
  if (!sentenceBusy()) documentFile.click();
});
manualEntryButton.addEventListener('click', toggleManualEntry);
reviewButton.addEventListener('click', handleReviewClick);
function handleDraftInput() {
  syncWorkspace();
  queueDraftSave();
}
sourceSelect.addEventListener('change', handleDraftInput);
documentPreview.addEventListener('input', handleDraftInput);
documentPreview.addEventListener('beforeinput', (event) => {
  sentenceInputHint = ['historyUndo', 'historyRedo'].includes(event?.inputType) ? { inputType: event.inputType }
    : { start: documentPreview.selectionStart, end: documentPreview.selectionEnd };
});
$('#sentence-editor').addEventListener('input', handleDraftInput);
$('#apply-sentence-edit').addEventListener('click', applySentenceEdit);
$('#cancel-sentence-edit').addEventListener('click', cancelSentenceEdit);
$('#return-to-result').addEventListener('click', returnToSentenceResult);
$('#previous-sentence').addEventListener('click', () => locateSentence(activeSentenceIndex - 1));
$('#next-sentence').addEventListener('click', () => locateSentence(activeSentenceIndex + 1));
documentTitle.addEventListener('input', handleDraftInput);
$('#clear-button').addEventListener('click', handleClear);
$('#retry-history').addEventListener('click', () => openHistory(new URLSearchParams(window.location.search).get('review')));
$('#save-decisions').addEventListener('click', () => saveDecisions());
$('#discard-decisions').addEventListener('click', discardDecisions);
$('#export-report').addEventListener('click', exportReport);
$('#restore-draft').addEventListener('click', () => {
  if (sentenceBusy() || !currentRecord || !guardSentenceEdit() || !window.confirm('恢复本版留档正文、标题和资料选择？尚未复核的文稿修改将被放弃，人工处理意见会保留。')) return;
  restoreRecordDraft();
  queueDraftSave();
  flushDraftSave();
  workflowMessage('已恢复本版留档文稿。');
});
window.addEventListener('beforeunload', (event) => {
  flushDraftSave();
  if (activeUpload || activeReview || activeSave || !isLocalDraftSaved()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
workspaceTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectWorkspaceTab(index));
  tab.addEventListener('keydown', (event) => {
    let nextIndex;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % workspaceTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index + workspaceTabs.length - 1) % workspaceTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = workspaceTabs.length - 1;
    else return;
    event.preventDefault();
    selectWorkspaceTab(nextIndex, true);
  });
});

async function initializeWorkspace() {
  workspaceInitializing = true;
  selectWorkspaceTab(0);
  syncWorkspace();
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.has('review')) {
    await Promise.all([loadSources(), openHistory(parameters.get('review'))]);
  } else if (parameters.has('source')) {
    activeSourceSelection = true;
    sourceSelect.value = '';
    syncWorkspace();
    try {
      const loaded = await loadSources();
      const source = parameters.get('source');
      const sourceId = Number(source);
      if (parameters.getAll('source').length !== 1 || !/^[1-9][0-9]*$/.test(source) || !Number.isSafeInteger(sourceId)) {
        workflowMessage('资料地址无效，请从「资料馆」重新选择资料。', true);
      } else if (!loaded) {
        workflowMessage('暂时无法载入所选资料，请恢复服务后刷新页面重试。', true);
      } else if (!availableSourceIds.has(sourceId)) {
        workflowMessage('所选资料暂无可用证据，请从「资料馆」重新选择资料。', true);
      } else {
        sourceSelect.value = String(sourceId);
        workflowMessage('已选择资料馆中的资料，请上传 Word 或 PDF 文稿后开始审阅。');
      }
    } finally {
      activeSourceSelection = false;
      syncWorkspace();
    }
  } else {
    await loadSources();
  }
  workspaceInitializing = false;
  initializeDrafts();
  initializeGuide();
  syncWorkspace();
}

const sourcePicker = window.SourcePicker?.create({ select: sourceSelect, onSelect: handleDraftInput }) || null;
function focusSourcePicker() {
  if (sourcePicker) sourcePicker.focus();
  else sourceSelect.focus();
}

bindDraftEvents();
bindGuideEvents();
initializeWorkspace();

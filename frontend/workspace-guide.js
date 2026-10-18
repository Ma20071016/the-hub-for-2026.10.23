/* Reading guidance only. Sample loading never runs inference or saves a review. */
const GUIDE_EXAMPLE = Object.freeze({
  key: 'robe-demo',
  title: '【教学示例】绿棉袍说明核对',
  sourceTitle: '新疆喀什维吾尔族绿棉袍',
  sourceURL: 'http://biftmuseum.com/collection/info?sid=14671&nationSid=5&colCatSid=2&nationName=维吾尔族',
  text: '这件新疆喀什维吾尔族绿棉袍采用对襟设计。\n这件棉袍通体为红色。\n这件棉袍的主人喜欢听音乐。',
  quotes: Object.freeze([
    '衣身宽大、造型简洁，对襟，两侧缝开短衩，衣身可见明显绗缝线迹，门襟处由于线迹紧密而出轻微褶皱。袖口、门襟、底摆均装饰有黄、白、黑色毛线编结的窄线条装饰。',
    '此件棉袍质地为棉质色织布，衣身蓝绿色兼织黄、紫、红色。衣里为木戳印花工艺印制的碎花棉布，里子衣襟贴边为黄绿色艾德莱斯绸面料。',
  ]),
});
let guideSourceMatches = [];
let activeExampleLoad = null;
let guideExampleMessage = '';

function guideExampleBlocker() {
  if (currentRecord || new URLSearchParams(window.location.search).has('review')) return '当前正在查看审阅档案。请从“开始新审阅”进入空白工作台后使用示例。';
  if (documentTitle.value || documentPreview.value || sourceSelect.value || documentFile.value) return '当前已有文稿或资料选择。请先保存或导出自己的内容，再清空后载入示例。';
  if (!draftSession || draftSession.pending || draftSession.error || draftSession.external) return '请先处理“本机草稿”中的恢复、冲突或存储提示，再载入示例。';
  if (guideSourceMatches.length !== 1 || !availableSourceIds.has(guideSourceMatches[0])) return '示例所需的绿棉袍资料暂不可用。可先阅读使用指南，或刷新重试。';
  return '';
}

function guideNextAction() {
  if (workspaceInitializing || activeSourceSelection || activeHistory) return { text: '正在准备资料和档案，请稍候。' };
  if (activeExampleLoad) return { text: '正在核对示例对应的资料原文…' };
  if (activeUpload || activeReview || activeSave) return { text: '当前操作正在进行，请等待完成。' };
  if (draftSession?.pending || draftSession?.external || draftSession?.error) return { text: '先查看本机草稿提示，恢复或处理旧副本，避免丢失之前的输入。', target: 'local-draft-title', label: '查看草稿提示' };
  if (hasSentenceEdit()) return { text: '这句修改还未应用。先应用到正文，再复核。', target: 'apply-sentence-edit', tab: 0, label: '前往本句修改' };
  if (decisionsDirty()) return { text: '人工意见尚未保存，点击“保存”后才会进入审阅档案。', target: 'save-decisions', tab: 1, label: '前往保存意见' };
  if (currentRecord && hasDraftChanges()) return { text: '正文或资料选择已变化。修改后复核会生成新版本。', target: 'review-document', label: '前往修改后复核' };
  if (currentRecord) {
    const unreviewed = localDecisions.filter(item => item.state === 'unreviewed').length;
    if (unreviewed) return { text: `还有 ${unreviewed} 句未记人工意见。先对照资料原文，再选择处理方式。`, target: 'decision-workbench', tab: 1, label: '查看人工复核' };
    const pending = localDecisions.some(item => item.state === 'pending');
    return { text: pending ? '意见已保存，仍有待补证句子。可以继续补核，或导出包含待处理内容的本版报告。' : '本版人工意见已保存。可导出报告，或继续修改后复核；保存意见不代表内容已全部正确。', target: 'export-report', tab: 1, label: '前往报告导出' };
  }
  if (!documentPreview.value.trim()) return { text: '先上传 Word 或 PDF 文稿，也可手动输入文本或载入下面的教学示例。', target: 'choose-document', tab: 0, label: '前往上传文稿' };
  if (!availableSourceIds.has(Number(sourceSelect.value))) return { text: '选择一份备用资料，供全库未匹配时使用，再开始审阅。', target: 'source-select', label: '前往选择资料' };
  return { text: '文稿与资料已准备好。点击“整篇审阅”，查看真实的逐句结果。', target: 'review-document', label: '前往整篇审阅' };
}

function syncGuideUI() {
  const busy = sentenceBusy();
  const reason = guideExampleBlocker();
  $('#load-guide-example').disabled = busy || Boolean(reason);
  $('#guide-example-status').textContent = guideExampleMessage || (busy ? '待当前操作完成后可载入示例。' : reason)
    || '仅在空白工作台载入。载入后请自行点击“整篇审阅”；完成后会以“教学示例”标题留档。';
  $('#guide-example-notice').hidden = !documentTitle.value.startsWith('【教学示例】');
  const next = guideNextAction();
  $('#guide-current-step').textContent = next.text;
  $('#guide-next').hidden = !next.target;
  $('#guide-next').disabled = busy;
  $('#guide-next').textContent = next.label || '查看下一步';
}

function initializeGuide() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('example')) {
    $('#workspace-guide').open = false;
    return;
  }
  $('#workspace-guide').open = true;
  if (params.getAll('example').length !== 1 || params.get('example') !== GUIDE_EXAMPLE.key) {
    guideExampleMessage = '示例地址无效，请通过使用指南中的入口重新打开。';
  } else if (params.has('review') || params.has('source')) {
    guideExampleMessage = '已保留地址中的档案或资料选择。示例只在空白工作台手动载入。';
  } else {
    guideExampleMessage = '';
  }
}

function guideWorkspaceSnapshot() {
  return JSON.stringify([documentTitle.value, documentPreview.value, sourceSelect.value, documentFile.value,
    currentRecord?.review_id || null, draftSession?.raw, window.location.search]);
}

function validGuideSource(data, id) {
  return data?.source?.id === id && data.source.title === GUIDE_EXAMPLE.sourceTitle
    && data.source.source_url === GUIDE_EXAMPLE.sourceURL && Array.isArray(data.evidence)
    && GUIDE_EXAMPLE.quotes.every(quote => data.evidence.filter(item => item?.object_name === GUIDE_EXAMPLE.sourceTitle
      && item.text === quote && Number.isSafeInteger(item.id) && item.id > 0).length === 1);
}

async function loadGuideExample() {
  if (sentenceBusy()) return;
  const blocked = guideExampleBlocker();
  if (blocked) { guideExampleMessage = blocked; syncGuideUI(); return; }
  const before = guideWorkspaceSnapshot();
  const controller = new AbortController();
  activeExampleLoad = controller;
  guideExampleMessage = '正在核对绿棉袍资料与示例依据…';
  syncWorkspace();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const id = guideSourceMatches[0];
    const detail = await requestJSON(`/api/library/${id}`, { signal: controller.signal });
    if (!validGuideSource(detail, id)) throw new Error('示例对应的资料或原文已变化，暂未载入。请先在资料馆核对。');
    if (guideWorkspaceSnapshot() !== before || guideExampleBlocker()) throw new Error('当前工作台内容已变化，示例未载入，请核对后重试。');
    const latest = draftStore.read(null);
    if (!latest.ok || latest.raw !== draftSession.raw) {
      draftOperationFailed(latest.ok ? { reason: 'conflict' } : latest);
      throw new Error('本机草稿状态已变化，请先处理草稿提示。');
    }
    documentTitle.value = GUIDE_EXAMPLE.title;
    documentPreview.value = GUIDE_EXAMPLE.text;
    sourceSelect.value = String(id);
    guideExampleMessage = '教学示例已载入，尚未审阅。请点击“整篇审阅”，并结合原文自行核对模型判断。';
    selectWorkspaceTab(0);
    queueDraftSave();
    flushDraftSave();
    syncWorkspace();
    documentPreview.focus();
  } catch (error) {
    guideExampleMessage = controller.signal.aborted ? '核对示例资料超时，请重试。当前文稿未替换。'
      : error instanceof TypeError ? '暂时无法读取示例资料，请确认服务已启动后重试。' : error.message;
  } finally {
    clearTimeout(timeout);
    activeExampleLoad = null;
    syncWorkspace();
  }
}

function bindGuideEvents() {
  $('#load-guide-example').addEventListener('click', loadGuideExample);
  $('#guide-next').addEventListener('click', () => {
    if (sentenceBusy()) return;
    const next = guideNextAction();
    if (next.tab !== undefined) selectWorkspaceTab(next.tab);
    if (!next.target) return;
    if (next.target === 'source-select') { focusSourcePicker(); return; }
    const target = $(`#${next.target}`);
    target.scrollIntoView({ block: 'center', behavior: 'auto' });
    target.focus({ preventScroll: true });
  });
}

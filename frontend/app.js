const REQUEST_TIMEOUT_MS = 120000;
// 整篇审阅要逐句跑模型，比单条核验慢得多，单独放宽。
const REVIEW_TIMEOUT_MS = 600000;
const START_HELP = '请在项目目录运行 python -m backend.serve，再通过服务地址打开页面。';

const $ = (selector) => document.querySelector(selector);

/* ---------- 元素引用 ---------- */

const documentFile = $('#document-file');
const documentStatus = $('#document-status');
const documentPreviewBox = $('#document-preview-box');
const documentPreview = $('#document-preview');
const sourceSelect = $('#source-select');
const sourceHelp = $('#source-help');
const reviewButton = $('#review-document');
const reviewProgress = $('#review-progress');
const reviewResultBox = $('#review-result-box');
const reviewResult = $('#review-result');
const reviewStatus = $('#review-status');

let activeUpload = null;
let activeReview = null;

/* ---------- 小工具 ---------- */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 服务状态指示：页头那颗小圆点。
function setServiceState(state, text) {
  const dot = $('#service-dot');
  dot.className = `status-dot ${state}`;
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

async function requestJSON(path, options) {
  if (window.location.protocol === 'file:') throw new Error(START_HELP);
  const response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  if ([404, 405, 501].includes(response.status)) throw new Error(`服务尚未启动。${START_HELP}`);
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error(`服务没有返回有效数据。${START_HELP}`);
  }
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (options.signal.aborted) throw error;
    throw new Error('服务返回的内容无法读取，请稍后重试。');
  }
  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `服务暂时不可用（${response.status}），请稍后重试。`);
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
      const option = element('option', '', source.object_name && source.object_name !== source.title
        ? `${source.object_name} · ${source.title}` : source.title);
      option.value = String(source.id);
      sourceSelect.append(option);
    });
    sourceSelect.disabled = data.sources.length === 0;
    sourceHelp.textContent = data.approved_count > 0
      ? `当前有 ${data.approved_count} 条已审核证据，来自 ${data.sources.length} 份资料。`
      : '尚无已审核证据。资料审核通过后，刷新页面即可检索。';
    setServiceState(
      data.sources.length ? 'ready' : 'offline',
      data.sources.length ? `资料库就绪 · ${data.approved_count} 条证据` : '资料库为空'
    );
  } catch (error) {
    sourceHelp.textContent = controller.signal.aborted ? '读取资料列表超时，请刷新页面重试。'
      : error instanceof TypeError ? `无法连接服务。${START_HELP}` : error.message;
    setServiceState('offline', '服务未连接');
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- 文档上传 ---------- */

function resetDocumentUpload() {
  if (activeUpload) activeUpload.abort();
  activeUpload = null;

  documentPreview.value = '';
  documentPreviewBox.hidden = true;
  documentStatus.textContent = '';
  $('#document-count').textContent = '';
}

async function handleDocumentChange() {
  const file = documentFile.files[0];

  resetDocumentUpload();
  resetReview();
  documentFile.value = ''; // 允许再次选择同一个文件重试。

  if (!file) return;

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

    documentPreview.value = data.text;
    documentPreviewBox.hidden = false;
    $('#document-count').textContent = `${data.text.length} 字符`;
    documentStatus.textContent = `已读取：${file.name}。${data.warning || ''}`;

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
    }
  }
}

/* ---------- 整篇审阅 ---------- */

function resetReview() {
  if (activeReview) activeReview.abort();
  activeReview = null;

  reviewProgress.hidden = true;
  reviewResultBox.hidden = true;
  reviewResult.replaceChildren();
  reviewStatus.textContent = '';
  $('#review-badge').textContent = '';
  reviewButton.disabled = false;
  reviewButton.classList.remove('busy');
  $('#review-button-label').textContent = '整篇审阅';
}

function validateReviewResponse(data) {
  if (!data || data.status !== 'completed'
    || !Array.isArray(data.problems)
    || !data.stats || !Number.isInteger(data.stats.total_sentences)
    || !Number.isInteger(data.stats.checked_sentences)
    || !Number.isInteger(data.stats.problems_found)) {
    throw new Error('审阅结果格式不正确。');
  }
  for (const problem of data.problems) {
    if (!problem || typeof problem.sentence !== 'string'
      || typeof problem.evidence !== 'string'
      || typeof problem.object_name !== 'string') {
      throw new Error('问题条目格式不正确。');
    }
  }
  return data;
}

function showReviewResult(data) {
  const { stats, problems } = data;
  reviewResultBox.hidden = false;
  reviewResult.replaceChildren();

  $('#review-badge').textContent = `${stats.problems_found} 处存疑`;

  // 摘要：只报总句数与判定结果，不展示中间过程。
  const summary = element('div', 'review-summary');
  const entries = [
    ['总句数', stats.total_sentences, false],
    ['逐句比对', stats.checked_sentences, false],
    ['判为矛盾', stats.problems_found, true],
  ];
  for (const [label, value, bad] of entries) {
    const stat = element('div', `review-stat${bad && value > 0 ? ' bad' : ''}`);
    stat.append(element('strong', '', String(value)), element('span', '', label));
    summary.append(stat);
  }

  if (!problems.length) {
    const empty = element('div', 'review-empty');
    const mark = element('span', 'mark', '合');
    mark.setAttribute('aria-hidden', 'true');
    empty.append(
      mark,
      element('p', '', '没有发现与资料相矛盾的说法。')
    );
    reviewResult.append(empty, summary);
    reviewStatus.textContent = '审阅完成。';
    return;
  }

  problems.forEach((problem, index) => {
    const card = element('article', 'problem-card');
    card.append(element('span', 'problem-tag', `第 ${index + 1} 处`));

    const claim = element('p', 'problem-claim', problem.sentence);
    card.append(claim);

    card.append(element('p', 'problem-label', `资料原文 · ${problem.object_name}`));
    card.append(element('blockquote', '', problem.evidence));

    const source = element('p', 'problem-source', '来源：');
    source.append(sourceLink(problem.source_url, problem.source_title || '资料'));
    card.append(source);

    reviewResult.append(card);
  });

  reviewResult.append(summary);
  reviewStatus.textContent = `审阅完成，发现 ${stats.problems_found} 处与资料相矛盾。`;
}

async function handleReviewClick() {
  if (activeReview) return;

  const text = documentPreview.value.trim();
  if (!text) {
    documentStatus.textContent = '请先上传文档并等待文字读取完成。';
    return;
  }
  if (sourceSelect.disabled || !sourceSelect.value) {
    documentStatus.textContent = '请先在上方选择一份对应资料，再开始整篇审阅。';
    sourceSelect.focus();
    return;
  }

  const controller = new AbortController();
  activeReview = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REVIEW_TIMEOUT_MS);

  reviewButton.disabled = true;
  reviewButton.classList.add('busy');
  $('#review-button-label').textContent = '正在逐句比对…';
  reviewProgress.hidden = false;
  reviewResultBox.hidden = true;
  reviewStatus.textContent = '';
  documentStatus.textContent = '正在逐句比对，请勿关闭页面。';

  try {
    const data = validateReviewResponse(await requestJSON('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        source_id: Number(sourceSelect.value),
      }),
      signal: controller.signal,
    }));

    if (activeReview !== controller) return;
    showReviewResult(data);
    documentStatus.textContent = '整篇审阅已完成。';
    reviewResultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch (error) {
    if (activeReview !== controller) return;
    const message = timedOut ? '审阅等待超过 10 分钟，请缩短文稿后重试。'
      : error instanceof TypeError ? `无法连接服务。${START_HELP}` : error.message;
    reviewResultBox.hidden = false;
    reviewResult.replaceChildren();
    reviewStatus.textContent = message;
    documentStatus.textContent = '本次审阅未完成。';

  } finally {
    clearTimeout(timeout);
    reviewProgress.hidden = true;
    if (activeReview === controller) {
      activeReview = null;
      reviewButton.disabled = false;
      reviewButton.classList.remove('busy');
      $('#review-button-label').textContent = '整篇审阅';
    }
  }
}

/* ---------- 清空 ---------- */

// 上传、预览、审阅结果一次复位。表单里的选择一并清掉。
function handleClear() {
  resetDocumentUpload();
  resetReview();
  documentFile.value = '';
  documentStatus.textContent = '';
  sourceSelect.value = '';
}

/* ---------- 事件监听（统一在最后注册） ---------- */

documentFile.addEventListener('change', handleDocumentChange);
reviewButton.addEventListener('click', handleReviewClick);
sourceSelect.addEventListener('change', resetReview);
$('#clear-button').addEventListener('click', handleClear);

loadSources();

const LABEL_TITLES = {
  supports: '支持',
  refutes: '反驳',
  insufficient: '信息不足',
};
const REQUEST_TIMEOUT_MS = 120000;
const START_HELP = '请在项目目录运行 python -m backend.serve，再通过服务地址打开页面。';
// 自拟交互示例，仅在折叠区展示；不作为检索结果或模型预测。
const examples = {
  supports: { title: '支持', description: '给定证据支持这条说明。', claim: '这件服饰采用交领设计。', evidence: '这件服饰的领型为交领，衣身为蓝色。' },
  refutes: { title: '反驳', description: '给定证据与这条说明存在矛盾。', claim: '这件服饰采用圆领设计。', evidence: '这件服饰的领型为交领，并非圆领。' },
  insufficient: { title: '信息不足', description: '给定证据不足以支持或反驳这条说明。', claim: '这件服饰制作于明代。', evidence: '这件服饰的领型为交领，衣身为蓝色。' },
};
const $ = (selector) => document.querySelector(selector);
const form = $('#verify-form');
const claimField = $('#claim');
const sourceSelect = $('#source-select');
const sourceHelp = $('#source-help');
const resultContent = $('#result-content');
const resultState = $('#result-state');
const errorMessage = $('#form-error');
const submitButton = $('#submit-button');
let activeRequest = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showEmpty(title = '等待一条服饰说明', description = '输入说明后查找相关证据；如果没有写明对象，可先限定一份资料。') {
  const container = element('div', 'empty-result');
  const symbol = element('div', 'empty-symbol', '证');
  symbol.setAttribute('aria-hidden', 'true');
  container.append(symbol, element('h3', '', title), element('p', '', description));
  resultContent.replaceChildren(container);
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.firstElementChild.textContent = busy ? '正在查找…' : '开始核验';
  $('.result-panel').setAttribute('aria-busy', String(busy));
}

function invalidateResult() {
  // 编辑或清空后取消旧请求，避免迟到的响应显示为新文本的结果。
  if (activeRequest) activeRequest.abort();
  activeRequest = null;
  errorMessage.hidden = true;
  claimField.setCustomValidity('');
  $('#claim-count').textContent = `${claimField.value.length} / 500`;
  setBusy(false);
  resultState.textContent = '等待输入';
  showEmpty();
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

function showSearchResult(data) {
  const completed = data.status === 'completed';
  const report = element('div', 'result-report');

  report.append(element('p', 'retrieval-notice',
    completed ? '模型预测 · 每条结论仅针对对应证据'
      : '本次尚未运行模型'));

  const claimSection = element('section', 'result-section');
  claimSection.append(
    element('h4', '', '本次说明'),
    element('p', '', data.claim)
  );
  report.append(
    claimSection,
    element('p', 'search-message', data.message)
  );

  data.matches.forEach((match, index) => {
    const section = element('section', 'result-section evidence-card');
    section.append(element('h4', '',
      `证据 ${index + 1} · ${match.object_name}`));

    const verdict = element('div', `verdict ${match.label}`);
    verdict.append(
      element('h3', '', `模型判断：${LABEL_TITLES[match.label]}`)
    );
    section.append(verdict);

    for (const [label, title] of Object.entries(LABEL_TITLES)) {
      const row = element('div', 'score-row');
      const bar = element('progress');
      bar.max = 1;
      bar.value = match.scores[label];
      bar.setAttribute('aria-label', `${title}的模型分类分数`);

      row.append(
        element('span', '', title),
        bar,
        element('span', '', `${(match.scores[label] * 100).toFixed(1)}%`)
      );
      section.append(row);
    }

    section.append(
      element('p', 'model-note', '分类分数不代表说明为真的概率。'),
      element('h4', '', `原文 · ${match.attribute}`),
      element('blockquote', '', match.evidence_text)
    );

    const source = element('p', 'source-text', '来源：');
    source.append(sourceLink(match.source_url, match.title));
    source.append(document.createTextNode(` · ${match.publisher}`));
    section.append(source);

    report.append(section);
  });

  resultContent.replaceChildren(report);
  resultState.textContent = {
    completed: '核验完成',
    no_evidence: '暂无证据',
    needs_context: '请选择资料',
  }[data.status];
}
function validateSearchResponse(data) {
  const fields = [
    'object_name', 'attribute', 'evidence_text', 'locator',
    'title', 'publisher', 'source_url',
  ];

  if (!data || !['completed', 'no_evidence', 'needs_context'].includes(data.status)
    || typeof data.claim !== 'string' || typeof data.message !== 'string'
    || !Array.isArray(data.matches)
    || data.matches.some((match) => !match
      || !Number.isInteger(match.id) || !Number.isInteger(match.source_id)
      || fields.some((key) => typeof match[key] !== 'string')
      || !Array.isArray(match.matched_terms)
      || match.matched_terms.some((term) => typeof term !== 'string'))) {
    throw new Error('核验结果格式不正确。');
  }

  if (data.status === 'completed') {
    if (data.model_status !== 'completed' || data.matches.length === 0) {
      throw new Error('模型没有返回完整结果。');
    }

    for (const match of data.matches) {
      const scores = Object.keys(LABEL_TITLES).map(
        (label) => match.scores?.[label]
      );

      if (!Object.hasOwn(LABEL_TITLES, match.label)
        || typeof match.claim_input !== 'string'
        || typeof match.evidence_input !== 'string'
        || scores.some((n) => !Number.isFinite(n) || n < 0 || n > 1)
        || Math.abs(scores.reduce((sum, n) => sum + n, 0) - 1) > 0.02) {
        throw new Error('模型类别或分数格式不正确。');
      }
    }
  } else if (data.model_status !== 'not_run' || data.matches.length !== 0) {
    throw new Error('未运行模型时不应返回预测结果。');
  }

  return data;
}

async function requestJSON(path, options) {
  if (window.location.protocol === 'file:') throw new Error(START_HELP);
  const response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...options.headers } });
  if ([404, 405, 501].includes(response.status)) throw new Error(`检索服务尚未启动。${START_HELP}`);
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error(`检索服务没有返回有效数据。${START_HELP}`);
  }
  let data;
  try { data = await response.json(); }
  catch (error) {
    if (options.signal.aborted) throw error;
    throw new Error('检索服务返回的内容无法读取，请稍后重试。');
  }
  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `检索服务暂时不可用（${response.status}），请稍后重试。`);
  }
  return data;
}

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
  } catch (error) {
    sourceHelp.textContent = controller.signal.aborted ? '读取资料列表超时，请刷新页面重试。'
      : error instanceof TypeError ? `无法连接检索服务。${START_HELP}` : error.message;
  } finally {
    clearTimeout(timeout);
  }
}

document.querySelectorAll('[data-example]').forEach((button) => {
  button.addEventListener('click', () => {
    const sample = examples[button.dataset.example];
    const report = element('div', 'demo-report');
    report.append(element('p', 'demo-notice', '示例结果 · 预先设定，非模型输出，非正式资料。'));
    const verdict = element('div', `verdict ${button.dataset.example}`);
    verdict.append(element('h3', '', sample.title), element('p', '', sample.description));
    const section = element('section', 'result-section');
    section.append(element('h4', '', '示例说明'), element('p', '', sample.claim), element('h4', 'demo-evidence-heading', '示例证据'), element('blockquote', '', sample.evidence));
    report.append(verdict, section);
    $('#demo-result').replaceChildren(report);
    document.querySelectorAll('[data-example]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  });
});

claimField.addEventListener('input', invalidateResult);
sourceSelect.addEventListener('change', invalidateResult);
$('#clear-button').addEventListener('click', () => {
  form.reset();
  invalidateResult();
  claimField.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (activeRequest) return;
  const claim = claimField.value.trim();
  claimField.setCustomValidity(!claim ? '请输入说明，不能只有空格。' : claim.length > 500 ? '说明最多为 500 字符。' : '');
  if (!form.reportValidity()) return;
    if (sourceSelect.disabled || !sourceSelect.value) {
    errorMessage.textContent = '请先加载并选择一份馆藏资料，再开始核验。';
    errorMessage.hidden = false;
    return;
  }
  const snapshot = { claim, source_id: sourceSelect.value ? Number(sourceSelect.value) : null };
  const controller = new AbortController();
  activeRequest = controller;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  errorMessage.hidden = true;
  setBusy(true);
  resultState.textContent = '正在核验';
  showEmpty(
    '正在检索证据并运行模型',
    '请稍候。编辑内容后，本次结果将不再显示。'
  );
  try {
    const data = validateSearchResponse(await requestJSON('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
      signal: controller.signal,
    }));
    if (activeRequest !== controller) return;
    showSearchResult(data);
  } catch (error) {
    if (activeRequest !== controller) return;
    errorMessage.textContent = timedOut ? '检索等待超过 120 秒，请稍后重试。'
      : error instanceof TypeError ? `无法连接检索服务。${START_HELP}` : error.message;
    errorMessage.hidden = false;
    resultState.textContent = '未完成';
    showEmpty('本次核验未完成', '输入内容已保留，服务恢复后可重新提交。');
  } finally {
    clearTimeout(timeout);
    if (activeRequest === controller) {
      activeRequest = null;
      setBusy(false);
    }
  }
});

showEmpty();
loadSources();

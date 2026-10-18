(() => {
  'use strict';

  const limit = 100;
  const requestTimeout = 15000;
  const idPattern = /^[0-9a-f]{32}$/;
  const decisionStates = ['unreviewed', 'confirmed', 'dismissed', 'pending'];
  const elements = {
    search: document.getElementById('archive-search'),
    filter: document.getElementById('archive-filter'),
    refresh: document.getElementById('refresh-archive'),
    retry: document.getElementById('retry-archive'),
    status: document.getElementById('archive-status'),
    count: document.getElementById('archive-count'),
    list: document.getElementById('archive-list'),
    empty: document.getElementById('archive-empty'),
    emptyTitle: document.getElementById('archive-empty-title'),
    emptyCopy: document.getElementById('archive-empty-copy'),
    emptyStart: document.getElementById('archive-empty-start'),
    reset: document.getElementById('archive-reset-filters'),
  };
  let reviews = [];
  let loaded = false;
  let loading = false;
  let loadError = '';
  let requestGeneration = 0;
  let activeController = null;
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false,
  });

  function validCount(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 50000;
  }

  function validateResponse(data) {
    if (!data || !Array.isArray(data.reviews) || data.reviews.length > limit) {
      throw new Error('档案数据格式异常，请稍后重试。');
    }
    const seen = new Set();
    for (const review of data.reviews) {
      const counts = review?.decision_counts;
      const total = review?.stats?.total_sentences;
      if (!review || typeof review.review_id !== 'string' || !idPattern.test(review.review_id)
          || seen.has(review.review_id) || typeof review.title !== 'string'
          || !review.title.trim() || [...review.title].length > 120
          || (review.parent_id !== null && (typeof review.parent_id !== 'string' || !idPattern.test(review.parent_id)))
          || typeof review.created_at !== 'string' || !Number.isFinite(Date.parse(review.created_at))
          || !validCount(total) || !counts || !decisionStates.every(state => validCount(counts[state]))
          || decisionStates.reduce((sum, state) => sum + counts[state], 0) !== total) {
        throw new Error('档案数据不完整，请刷新后重试。');
      }
      seen.add(review.review_id);
    }
    return data.reviews;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderRecord(review) {
    const item = node('li', 'archive-item');
    const link = node('a', 'archive-record');
    link.href = `./index.html?review=${review.review_id}`;
    const main = node('div', 'archive-record-main');
    main.append(node('h3', '', review.title));
    const meta = node('div', 'archive-record-meta');
    meta.append(node('span', 'archive-record-version', review.parent_id ? '修改后复核' : '初次审阅'));
    const time = node('time', '', dateFormatter.format(new Date(review.created_at)));
    time.dateTime = review.created_at;
    meta.append(time, node('span', '', `正文 ${review.stats.total_sentences} 句`),
      node('span', '', `记录 ${review.review_id.slice(0, 8)}`));
    main.append(meta);
    if (review.parent_id) {
      main.append(node('span', 'archive-record-parent', `基于记录 ${review.parent_id.slice(0, 8)} 复核`));
    }

    const total = review.stats.total_sentences;
    const counts = review.decision_counts;
    const reviewed = total - counts.unreviewed;
    const progress = node('div', 'archive-record-progress');
    progress.append(node('span', 'archive-progress-label', total ? `已记意见 ${reviewed} / ${total} 句` : '暂无可审阅句子'));
    const track = node('span', 'archive-progress-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = node('span');
    fill.style.width = `${total ? reviewed / total * 100 : 0}%`;
    track.append(fill);
    progress.append(track);
    const pending = [];
    if (counts.unreviewed) pending.push(`${counts.unreviewed} 句未处理`);
    if (counts.pending) pending.push(`${counts.pending} 句待补证`);
    progress.append(node('span', 'archive-record-pending', pending.join(' · ') || (total ? '全部句子已记录处理意见' : '可打开查看原文')));
    const arrow = node('span', 'archive-open-arrow', '→');
    arrow.setAttribute('aria-hidden', 'true');
    link.append(main, progress, arrow);
    item.append(link);
    return item;
  }

  function render() {
    const query = elements.search.value.trim().toLocaleLowerCase('zh-CN');
    const filter = elements.filter.value;
    const matches = reviews.filter(review => {
      const textMatch = !query || review.title.toLocaleLowerCase('zh-CN').includes(query)
        || review.review_id.includes(query);
      return textMatch && (filter === 'all' || review.decision_counts[filter] > 0);
    });
    const fragment = document.createDocumentFragment();
    matches.forEach(review => fragment.append(renderRecord(review)));
    elements.list.replaceChildren(fragment);
    elements.list.setAttribute('aria-busy', String(loading));
    elements.count.textContent = loaded ? `${reviews.length} 条已载入` : '';
    elements.search.disabled = !loaded;
    elements.filter.disabled = !loaded;
    elements.refresh.disabled = loading;
    elements.refresh.textContent = loading ? '正在读取…' : '刷新记录';
    elements.retry.hidden = !loadError || loading;
    elements.empty.hidden = !loaded || matches.length > 0;
    elements.emptyStart.hidden = reviews.length > 0;
    elements.reset.hidden = reviews.length === 0;
    if (reviews.length) {
      elements.emptyTitle.textContent = '没有找到符合条件的记录';
      elements.emptyCopy.textContent = '试试其他标题、记录号，或清除筛选。搜索范围为已载入的最近记录。';
    } else {
      elements.emptyTitle.textContent = '还没有审阅记录';
      elements.emptyCopy.textContent = '完成一次整篇审阅后，文稿和结果会自动保存在这里。';
    }
    elements.status.dataset.state = loadError ? 'error' : 'normal';
    if (loading) {
      elements.status.textContent = loaded ? '正在刷新，当前仍显示上次载入的记录…' : '正在读取审阅档案…';
    } else if (loadError) {
      elements.status.textContent = loadError + (loaded ? ' 当前仍显示上次成功载入的记录。' : '');
    } else {
      elements.status.textContent = loaded
        ? `显示 ${matches.length} / ${reviews.length} 条已载入记录${query || filter !== 'all' ? '，已应用搜索或筛选。' : '。'}`
        : '正在读取审阅档案…';
    }
  }

  async function loadReviews() {
    activeController?.abort();
    const generation = ++requestGeneration;
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeout);
    loading = true;
    loadError = '';
    render();
    try {
      const response = await (window.Account?.fetch || fetch)(`/api/reviews?limit=${limit}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`暂时无法读取审阅档案（${response.status}），请重试。`);
      const payload = await response.json();
      if (generation !== requestGeneration) return;
      if (controller.signal.aborted) throw new Error('读取已取消。');
      const data = validateResponse(payload);
      reviews = data;
      loaded = true;
    } catch (error) {
      if (generation !== requestGeneration) return;
      if (timedOut) loadError = '读取超时，请检查服务连接后重试。';
      else if (error instanceof SyntaxError) loadError = '档案数据格式异常，请稍后重试。';
      else if (error instanceof TypeError) loadError = '无法连接审阅服务，请确认服务已启动后重试。';
      else loadError = error?.message || '读取失败，请稍后重试。';
    } finally {
      clearTimeout(timer);
      if (generation === requestGeneration) {
        loading = false;
        activeController = null;
        render();
      }
    }
  }

  elements.search.addEventListener('input', render);
  elements.filter.addEventListener('change', render);
  elements.refresh.addEventListener('click', loadReviews);
  elements.retry.addEventListener('click', loadReviews);
  elements.reset.addEventListener('click', () => {
    elements.search.value = '';
    elements.filter.value = 'all';
    render();
    elements.search.focus();
  });
  window.addEventListener('pagehide', () => {
    ++requestGeneration;
    activeController?.abort();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) loadReviews();
  });
  loadReviews();
})();

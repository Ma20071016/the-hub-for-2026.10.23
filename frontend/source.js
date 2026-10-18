(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const rawId = params.get('id') || '';
  const id = Number(rawId);
  let generation = 0;
  let activeController = null;
  const backQuery = new URLSearchParams();
  for (const key of ['q', 'attribute', 'publisher', 'images']) {
    const value = params.get(key);
    if (value) backQuery.set(key, value.slice(0, 200));
  }
  $('source-back').href = `./library.html${backQuery.size ? `?${backQuery}` : ''}`;

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function strings(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
  }

  function validResponse(data) {
    if (!data || !data.source || data.source.id !== id
      || !['title', 'publisher', 'source_url', 'original_text'].every(key => typeof data.source[key] === 'string')
      || (data.source.retrieved_at !== null && typeof data.source.retrieved_at !== 'string')
      || !data.source.title.trim() || !Array.isArray(data.objects) || !Array.isArray(data.evidence)
      || !strings(data.catalog_numbers) || data.evidence_count !== data.evidence.length || data.evidence_count < 1) return false;
    const evidenceIds = new Set();
    for (const evidence of data.evidence) {
      if (!evidence || !Number.isSafeInteger(evidence.id) || evidence.id <= 0 || evidenceIds.has(evidence.id)
        || !['object_name', 'text', 'locator'].every(key => typeof evidence[key] === 'string')
        || !['aliases', 'attributes', 'keywords'].every(key => strings(evidence[key]))
        || typeof evidence.locator_verified !== 'boolean'
        || !['start', 'end'].every(key => evidence[key] === null || (Number.isSafeInteger(evidence[key]) && evidence[key] >= 0))) return false;
      evidenceIds.add(evidence.id);
    }
    const assigned = new Set();
    for (const object of data.objects) {
      if (!object || typeof object.name !== 'string' || !strings(object.aliases) || !strings(object.attributes)
        || !Array.isArray(object.evidence_ids) || !object.evidence_ids.length) return false;
      for (const evidenceId of object.evidence_ids) {
        if (!evidenceIds.has(evidenceId) || assigned.has(evidenceId)
          || data.evidence.find(evidence => evidence.id === evidenceId).object_name !== object.name) return false;
        assigned.add(evidenceId);
      }
    }
    return assigned.size === evidenceIds.size && window.SourceVisuals.validVisuals(data.visuals, evidenceIds);
  }

  function safeURL(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function tags(attributes) {
    const list = node('div', 'source-tags');
    attributes.forEach(attribute => list.append(node('span', 'library-tag', attribute)));
    return list;
  }

  function canLocate(evidence, characters) {
    return evidence.locator_verified && Number.isSafeInteger(evidence.start) && Number.isSafeInteger(evidence.end)
      && evidence.start >= 0 && evidence.end > evidence.start && evidence.end <= characters.length
      && characters.slice(evidence.start, evidence.end).join('') === evidence.text;
  }

  function locate(evidence, characters) {
    if (!canLocate(evidence, characters)) return;
    const original = $('source-original');
    const highlight = node('mark', '', characters.slice(evidence.start, evidence.end).join(''));
    highlight.id = 'source-active-evidence';
    highlight.tabIndex = -1;
    original.replaceChildren(document.createTextNode(characters.slice(0, evidence.start).join('')),
      highlight, document.createTextNode(characters.slice(evidence.end).join('')));
    $('source-original-details').open = true;
    $('source-locator-status').textContent = `已定位证据 ${evidence.id}，高亮部分与证据摘录一致。`;
    highlight.focus({ preventScroll: true });
    highlight.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  }

  function evidenceCard(evidence, characters) {
    const card = node('article', 'source-evidence-card');
    card.id = `evidence-${evidence.id}`;
    card.tabIndex = -1;
    const top = node('div', 'source-evidence-top');
    top.append(tags(evidence.attributes), node('span', '', `证据 ${String(evidence.id).padStart(3, '0')}`));
    const quote = node('blockquote', '', evidence.text);
    const bottom = node('div', 'source-evidence-bottom');
    const locatable = canLocate(evidence, characters);
    const locatorLabel = locatable ? `原文第 ${evidence.start + 1}–${evidence.end} 字`
      : evidence.locator && !evidence.locator.startsWith('chars:') ? evidence.locator : '原文位置待核对';
    bottom.append(node('span', '', locatorLabel));
    if (locatable) {
      const button = node('button', 'text-button', '定位原文 ↓');
      button.type = 'button';
      button.setAttribute('aria-label', `定位证据 ${evidence.id} 的原文`);
      button.addEventListener('click', () => locate(evidence, characters));
      bottom.append(button);
    } else {
      bottom.append(node('span', '', '请展开原文核对'));
    }
    card.append(top, quote, bottom);
    return card;
  }

  function render(data) {
    const source = data.source;
    const characters = Array.from(source.original_text);
    document.title = `${source.title} · 资料馆`;
    $('source-title').textContent = source.title;
    $('source-reference').textContent = `资料 ${String(id).padStart(3, '0')} / 资料馆`;
    $('source-review').href = `./index.html?source=${id}`;
    const metadata = $('source-metadata');
    metadata.replaceChildren(node('span', '', source.publisher || '发布机构未注明'));
    if (source.retrieved_at) {
      const parsed = Date.parse(source.retrieved_at);
      metadata.append(node('span', '', `采集于 ${Number.isFinite(parsed) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(parsed)) : source.retrieved_at}`));
    } else metadata.append(node('span', '', '采集日期未记录'));
    const url = safeURL(source.source_url);
    if (url) {
      const link = node('a', '', '查看原始出处 ↗');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      metadata.append(link);
    } else metadata.append(node('span', '', '原始链接暂不可用'));
    $('source-objects').replaceChildren();
    $('source-evidence').replaceChildren();
    const byId = new Map(data.evidence.map(evidence => [evidence.id, evidence]));
    data.objects.forEach((object, index) => {
      const li = node('li', 'source-object');
      const name = node('a', 'source-object-name', object.name || '资料所述对象');
      name.href = `#object-${index + 1}`;
      li.append(name);
      const otherNames = object.aliases.filter(alias => alias !== object.name);
      if (otherNames.length) li.append(node('p', '', `相关称谓：${otherNames.join('、')}`));
      li.append(tags(object.attributes));
      $('source-objects').append(li);
      const group = node('section', 'source-evidence-group');
      group.id = `object-${index + 1}`;
      group.append(node('h3', '', `${object.name || '资料所述对象'} · ${object.evidence_ids.length} 条证据`));
      object.evidence_ids.forEach(evidenceId => group.append(evidenceCard(byId.get(evidenceId), characters)));
      $('source-evidence').append(group);
    });
    $('source-numbers').hidden = !data.catalog_numbers.length;
    $('source-numbers').replaceChildren(node('strong', '', '资料涉及的馆藏编号'), node('span', '', data.catalog_numbers.join(' · ')));
    $('source-evidence-count').textContent = `${data.evidence_count} 条已审核`;
    $('source-original').textContent = source.original_text || '本资料暂未保存完整原文，请查看原始出处。';
    $('source-locator-status').textContent = '';
    $('source-original-details').open = false;
    const visuals = data.visuals || [];
    const hasImages = visuals.length > 0;
    const hasAnnotations = visuals.some(visual => visual.hotspots.length > 0);
    $('source-visual-title').textContent = hasImages ? '近观藏品' : '文献资料';
    $('source-visual-kind').textContent = hasImages ? '馆藏影像 · 图文对读' : '原文与证据';
    $('source-visual-intro').textContent = !hasImages
      ? '本资料暂未收录馆藏配图，可继续阅读下方的已审核证据与资料原文。'
      : hasAnnotations
        ? '在设有编号的配图中，选择编号或文字标注，细看一处纹样，再读它在资料原文中的描述。'
        : '浏览馆藏配图，结合下方的已审核证据与资料原文了解细节。';
    $('source-visual-note').hidden = !hasAnnotations;
    window.SourceVisuals.render($('source-visuals'), visuals, byId, {
      canLocate: evidence => canLocate(evidence, characters),
      locate: evidence => locate(evidence, characters),
      showEvidence: evidence => {
        const card = $(`evidence-${evidence.id}`);
        card.focus({ preventScroll: true });
        card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      },
    });
    $('source-content').hidden = false;
    $('source-content').setAttribute('aria-busy', 'false');
    $('source-feedback').hidden = true;
  }

  async function load() {
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id)) {
      $('source-status').textContent = '资料编号无效。请返回资料馆重新选择资料。';
      $('source-status').dataset.state = 'error';
      return;
    }
    const requestGeneration = ++generation;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    $('source-feedback').hidden = false;
    $('source-retry').hidden = true;
    $('source-content').hidden = true;
    $('source-status').textContent = '正在读取资料与证据…';
    $('source-status').dataset.state = 'loading';
    try {
      const response = await fetch(`/api/library/${id}`, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.status === 404) throw new Error('这份资料暂不可用，或尚无已审核证据。请返回资料馆选择其他资料。');
      if (!response.ok) throw new Error(`资料暂时无法读取（${response.status}），请重试。`);
      const data = await response.json();
      if (requestGeneration !== generation) return;
      if (controller.signal.aborted) throw new Error('读取已取消，请重试。');
      if (!validResponse(data)) throw new Error('资料数据格式异常，请重新读取。');
      render(data);
    } catch (error) {
      if (requestGeneration !== generation) return;
      $('source-status').textContent = timedOut ? '读取超时，请检查服务后重试。'
        : error instanceof SyntaxError ? '资料数据格式异常，请重新读取。'
        : error instanceof TypeError ? '无法连接资料服务，请确认服务已启动后重试。'
        : error.message || '无法连接资料服务，请重试。';
      $('source-status').dataset.state = 'error';
      $('source-retry').hidden = false;
    } finally {
      window.clearTimeout(timer);
      if (requestGeneration === generation) activeController = null;
    }
  }
  $('source-retry').addEventListener('click', load);
  window.addEventListener('pagehide', () => { ++generation; activeController?.abort(); });
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  load();
})();

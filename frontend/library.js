(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const controls = [$('library-search'), $('library-attribute'), $('library-publisher'), $('library-images')];
  const params = new URLSearchParams(window.location.search);
  let sources = [];
  let visibleLimit = 12;
  let generation = 0;
  let activeController = null;
  let loaded = false;
  let featuredSources = [];
  let featuredIndex = 0;
  let featureGeneration = 0;
  const backdrop = window.MuseumBackdrop?.create();
  controls[0].value = (params.get('q') || '').slice(0, 200);
  controls[3].checked = params.get('images') === '1';

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
    const count = value => Number.isSafeInteger(value) && value >= 0;
    if (!data || !Array.isArray(data.sources) || !data.stats
      || !count(data.stats.available_sources) || !count(data.stats.approved_evidence)
      || data.stats.available_sources !== data.sources.length
      || !strings(data.attributes) || !strings(data.publishers)) return false;
    const ids = new Set();
    for (const source of data.sources) {
      if (!source || !Number.isSafeInteger(source.id) || source.id <= 0 || ids.has(source.id)
        || !['title', 'publisher', 'source_url', 'excerpt'].every(key => typeof source[key] === 'string')
        || (source.retrieved_at !== null && typeof source.retrieved_at !== 'string')
        || !source.title.trim() || !count(source.evidence_count) || source.evidence_count < 1
        || !['object_names', 'aliases', 'attributes', 'keywords', 'catalog_numbers'].every(key => strings(source[key]))) return false;
      if (!window.SourceVisuals.validCatalogVisual(source)) return false;
      ids.add(source.id);
    }
    return data.sources.reduce((sum, source) => sum + source.evidence_count, 0) === data.stats.approved_evidence;
  }

  function setOptions(select, values, requested) {
    const label = select === controls[1] ? '全部方面' : '全部机构';
    select.replaceChildren(node('option', '', label));
    select.firstElementChild.value = '';
    for (const value of values) {
      const option = node('option', '', value);
      option.value = value;
      select.append(option);
    }
    select.value = values.includes(requested) ? requested : '';
  }

  function currentQuery() {
    const query = new URLSearchParams();
    if (controls[0].value.trim()) query.set('q', controls[0].value.trim());
    if (controls[1].value) query.set('attribute', controls[1].value);
    if (controls[2].value) query.set('publisher', controls[2].value);
    if (controls[3].checked) query.set('images', '1');
    return query;
  }

  function updateURL() {
    const query = currentQuery().toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }

  function detailURL(source, query) {
    const detailQuery = new URLSearchParams(query);
    detailQuery.set('id', String(source.id));
    return `./source.html?${detailQuery}`;
  }

  function updateFeatureLink() {
    const source = featuredSources[featuredIndex];
    if (source) $('museum-feature-link').href = detailURL(source, currentQuery());
  }

  function showFeature(index) {
    if (!featuredSources.length) return;
    featuredIndex = (index + featuredSources.length) % featuredSources.length;
    const source = featuredSources[featuredIndex];
    const thisGeneration = ++featureGeneration;
    $('museum-feature').hidden = false;
    $('museum-feature-title').textContent = source.title;
    $('museum-feature-publisher').textContent = source.publisher || '机构未注明';
    $('museum-feature-excerpt').textContent = source.excerpt;
    $('museum-feature-excerpt').hidden = !source.excerpt.trim();
    $('museum-feature-number').textContent = `资料 ${String(source.id).padStart(3, '0')}`;
    $('museum-feature-position').setAttribute('aria-atomic', 'true');
    $('museum-feature-position').textContent = `${featuredIndex + 1} / ${featuredSources.length} · ${source.title}`;
    $('museum-feature-previous').disabled = featuredSources.length < 2;
    $('museum-feature-next').disabled = featuredSources.length < 2;
    updateFeatureLink();

    const image = node('img', 'museum-feature-image');
    image.alt = source.cover.alt;
    image.width = source.cover.width;
    image.height = source.cover.height;
    image.decoding = 'async';
    const status = node('p', 'museum-feature-image-status', '正在读取馆藏配图…');
    status.setAttribute('role', 'status');
    image.addEventListener('load', () => {
      if (thisGeneration !== featureGeneration) return;
      status.hidden = true;
    });
    image.addEventListener('error', () => {
      if (thisGeneration !== featureGeneration) return;
      image.hidden = true;
      status.hidden = false;
      status.textContent = '配图暂不可用，仍可进入详情阅读原文与出处。';
    });
    $('museum-feature-media').replaceChildren(image, status);
    image.src = source.cover.url;
  }

  function renderCard(source, query) {
    const li = node('li');
    const card = node('a', 'library-card');
    card.href = detailURL(source, query);
    if (source.cover) {
      const preview = node('div', 'library-card-preview');
      const image = node('img');
      image.alt = source.cover.alt;
      image.width = source.cover.width;
      image.height = source.cover.height;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => {
        preview.replaceChildren(node('span', 'library-card-image-error', '配图暂不可用 · 进入详情查看出处'));
      });
      image.src = source.cover.url;
      preview.append(image, node('span', 'library-card-image-count', `${source.visual_count} 幅配图`));
      card.append(preview);
    } else {
      const archive = node('div', 'library-card-archive');
      archive.setAttribute('aria-hidden', 'true');
      archive.append(node('span', 'library-card-archive-label', '文献档案'),
        node('span', 'library-card-archive-number', String(source.id).padStart(3, '0')),
        node('span', 'library-card-archive-copy', '原文与证据'));
      card.append(archive);
    }
    const label = node('div', 'library-card-label');
    const meta = node('div', 'library-card-meta');
    meta.append(node('span', 'library-card-number', `资料 ${String(source.id).padStart(3, '0')}`),
      node('span', 'library-card-publisher', source.publisher || '机构未注明'));
    label.append(meta, node('h3', '', source.title));
    if (source.object_names.length) label.append(node('p', 'library-card-objects', `涉及对象 · ${source.object_names.join('、')}`));
    const excerpt = Array.from(source.excerpt);
    if (excerpt.length) label.append(node('blockquote', 'library-card-excerpt', `${excerpt.slice(0, 94).join('')}${excerpt.length > 94 ? '…' : ''}`));
    const tags = node('div', 'library-card-tags');
    source.attributes.slice(0, 4).forEach(attribute => tags.append(node('span', 'library-tag', attribute)));
    if (source.attributes.length > 4) tags.append(node('span', 'library-tag', `另 ${source.attributes.length - 4} 项`));
    const bottom = node('div', 'library-card-bottom');
    bottom.append(node('span', '', `${source.evidence_count} 条可用证据`), node('span', '', '阅读资料 →'));
    label.append(tags, bottom);
    card.append(label);
    li.append(card);
    return li;
  }

  function render() {
    if (!loaded) return;
    const query = controls[0].value.trim().toLocaleLowerCase();
    const tokens = query.split(/\s+/u).filter(Boolean);
    const attribute = controls[1].value;
    const publisher = controls[2].value;
    const hasImages = controls[3].checked;
    const filtered = sources.filter(source => {
      if (attribute && !source.attributes.includes(attribute)) return false;
      if (publisher && source.publisher !== publisher) return false;
      if (hasImages && !(source.visual_count > 0)) return false;
      const searchable = [source.title, source.publisher, ...source.object_names, ...source.aliases,
        ...source.attributes, ...source.keywords, ...source.catalog_numbers].join(' ').toLocaleLowerCase();
      return tokens.every(token => searchable.includes(token));
    });
    const shown = filtered.slice(0, visibleLimit);
    const queryParams = currentQuery();
    $('library-list').replaceChildren(...shown.map(source => renderCard(source, queryParams)));
    $('library-empty').hidden = filtered.length > 0;
    $('library-empty-title').textContent = sources.length ? '没有找到匹配资料' : '资料目录暂为空';
    $('library-empty-copy').textContent = sources.length ? '试试更简短的名称，或清除筛选条件。' : '资料审核入库后，会在这里展示对象、证据和出处。';
    $('library-status').textContent = `${query || attribute || publisher || hasImages ? '找到' : '共'} ${filtered.length} 份资料 · 目录总计 ${sources.length} 份${shown.length < filtered.length ? ` · 已显示 ${shown.length} 份` : ''}`;
    $('library-status').dataset.state = 'ready';
    $('library-reset').hidden = !(query || attribute || publisher || hasImages);
    $('library-more').hidden = shown.length >= filtered.length;
    $('library-more').textContent = `继续浏览 · 还有 ${filtered.length - shown.length} 份资料`;
    updateFeatureLink();
    updateURL();
  }

  async function load() {
    const requestGeneration = ++generation;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    loaded = false;
    backdrop?.clear();
    featuredSources = [];
    featuredIndex = 0;
    ++featureGeneration;
    $('museum-feature').hidden = true;
    $('museum-feature-media').replaceChildren();
    controls.forEach(control => { control.disabled = true; });
    $('library-status').textContent = '正在读取资料目录…';
    $('library-status').dataset.state = 'loading';
    $('library-list').setAttribute('aria-busy', 'true');
    $('library-list').replaceChildren();
    $('source-total').textContent = '—';
    $('evidence-total').textContent = '—';
    $('library-reset').hidden = true;
    $('library-retry').hidden = true;
    $('library-empty').hidden = true;
    $('library-more').hidden = true;
    try {
      const response = await fetch('/api/library', { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`资料目录暂时无法读取（${response.status}），请重试。`);
      const data = await response.json();
      if (requestGeneration !== generation) return;
      if (controller.signal.aborted) throw new Error('读取已取消，请重试。');
      if (!validResponse(data)) throw new Error('资料目录格式异常，请重新读取。');
      sources = data.sources;
      backdrop?.setSources(sources);
      featuredSources = sources.filter(source => source.cover);
      const current = new URLSearchParams(window.location.search);
      setOptions(controls[1], data.attributes, current.get('attribute'));
      setOptions(controls[2], data.publishers, current.get('publisher'));
      $('source-total').textContent = String(data.stats.available_sources);
      $('evidence-total').textContent = String(data.stats.approved_evidence);
      loaded = true;
      visibleLimit = 12;
      controls.forEach(control => { control.disabled = false; });
      showFeature(0);
      render();
    } catch (error) {
      if (requestGeneration !== generation) return;
      $('library-status').textContent = timedOut ? '读取超时，请检查服务后重试。'
        : error instanceof SyntaxError ? '资料目录格式异常，请重新读取。'
        : error instanceof TypeError ? '无法连接资料服务，请确认服务已启动后重试。'
        : error.message || '无法连接资料服务，请重试。';
      $('library-status').dataset.state = 'error';
      $('library-retry').hidden = false;
      $('library-list').replaceChildren();
    } finally {
      window.clearTimeout(timer);
      if (requestGeneration === generation) {
        $('library-list').setAttribute('aria-busy', 'false');
        activeController = null;
      }
    }
  }

  $('library-filters').addEventListener('submit', event => event.preventDefault());
  controls[0].addEventListener('input', () => { visibleLimit = 12; render(); });
  controls.slice(1).forEach(control => control.addEventListener('change', () => { visibleLimit = 12; render(); }));
  $('library-reset').addEventListener('click', () => { controls.forEach(control => { control.value = ''; }); controls[3].checked = false; visibleLimit = 12; render(); controls[0].focus(); });
  $('library-more').addEventListener('click', () => { visibleLimit += 12; render(); });
  $('library-retry').addEventListener('click', load);
  $('museum-feature-previous').addEventListener('click', () => showFeature(featuredIndex - 1));
  $('museum-feature-next').addEventListener('click', () => showFeature(featuredIndex + 1));
  window.addEventListener('pagehide', () => { ++generation; activeController?.abort(); });
  window.addEventListener('pageshow', event => { if (event.persisted) load(); });
  load();
})();

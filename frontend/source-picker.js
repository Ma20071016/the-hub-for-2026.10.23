(() => {
  'use strict';

  const CATEGORIES = [
    { key: 'clothing', title: '衣袍与裙装', matches: /棉袍|袷袢|裙|妇女服饰/u },
    { key: 'headwear', title: '帽饰与头巾', matches: /帽|头巾/u },
    { key: 'accessories', title: '鞋靴与随身用品', matches: /靴|褡裢/u },
    { key: 'textiles', title: '织染与印花', matches: /印花模戳|艾[德得特]莱[斯丝]绸/u },
    { key: 'embroidery', title: '刺绣与纹样', matches: /刺绣/u },
    { key: 'contemporary', title: '当代设计与应用', matches: /设计服饰|新中式衬衣|静态展羊毛擀毡配饰|潮品秀设计|时尚秀设计/u },
  ];
  const CATEGORY_ORDER = ['contemporary', 'headwear', 'accessories', 'clothing', 'textiles', 'embroidery'];
  const positiveId = value => Number.isSafeInteger(value) && value > 0;
  const stringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  const normalized = value => String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/艾[德得特]莱[斯丝]/gu, '艾德莱斯');
  const queryVariants = token => {
    const plain = token.replace(/帽子/gu, '帽').replace(/靴子/gu, '靴').replace(/袍子/gu, '袍');
    return plain === '鞋子' || plain === '鞋' ? ['鞋', '靴'] : [plain];
  };
  const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()))];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function validCover(cover) {
    return !!cover && typeof cover === 'object' && !Array.isArray(cover)
      && typeof cover.url === 'string'
      && /^\/img\/library\/[A-Za-z0-9][A-Za-z0-9_-]{0,159}\.(?:jpe?g|png|webp)$/i.test(cover.url)
      && typeof cover.alt === 'string' && !!cover.alt.trim()
      && [cover.width, cover.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 20000);
  }

  function validLibrary(data) {
    if (!data || !Array.isArray(data.sources)) return false;
    const seen = new Set();
    for (const source of data.sources) {
      if (!source || !positiveId(source.id) || seen.has(source.id)
        || typeof source.title !== 'string' || !source.title.trim()
        || typeof source.publisher !== 'string'
        || !['object_names', 'aliases', 'catalog_numbers', 'attributes', 'keywords'].every(key => stringList(source[key]))
        || !positiveId(source.evidence_count)) return false;
      const cover = source.cover;
      if (cover !== undefined && cover !== null && !validCover(cover)) return false;
      if (source.visual_count !== undefined
        && (!Number.isSafeInteger(source.visual_count) || source.visual_count < 0
          || source.visual_count > 50 || (source.visual_count === 0 ? cover != null : !validCover(cover)))) return false;
      seen.add(source.id);
    }
    return true;
  }

  function categoryOf(source) {
    const primary = source.object_names.find(value => value.trim()) || source.title;
    return CATEGORY_ORDER.find(key => CATEGORIES.find(category => category.key === key).matches.test(primary)) || 'other';
  }

  function create({ select, onSelect } = {}) {
    const $ = id => document.getElementById(id);
    const openButton = $('source-picker-open');
    const summary = $('source-picker-summary');
    const nativeField = $('source-native-field');
    const dialog = $('source-picker-dialog');
    const closeButton = $('source-picker-close');
    const search = $('source-picker-search');
    const categories = $('source-picker-categories');
    const status = $('source-picker-status');
    const retry = $('source-picker-retry');
    const reset = $('source-picker-reset');
    const list = $('source-picker-list');
    const empty = $('source-picker-empty');
    const more = $('source-picker-more');
    if (!select || typeof onSelect !== 'function'
      || ![openButton, summary, nativeField, dialog, closeButton, search, categories, status, retry, reset, list, empty, more].every(Boolean)
      || typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function') {
      if (nativeField) nativeField.hidden = false;
      if (openButton) openButton.hidden = true;
      return null;
    }

    let basic = new Map();
    let metadata = new Map();
    let baselineSignature = '';
    let revision = 0;
    let lastSyncSignature = '';
    let activeCategory = 'all';
    let visibleLimit = 8;
    let metadataState = 'idle';
    let requestGeneration = 0;
    let activeController = null;
    let focusTargets = new Map();
    let choiceButtons = [];
    let categoryButtons = [];
    let disposed = false;

    function currentSource(id) {
      const base = basic.get(id);
      if (!base) return null;
      const extra = metadata.get(id);
      return {
        id: base.id, title: base.title, object_names: extra ? extra.object_names : (base.object_name ? [base.object_name] : []),
        aliases: extra ? extra.aliases : [], catalog_numbers: extra ? extra.catalog_numbers : [],
        attributes: extra ? extra.attributes : [], keywords: extra ? extra.keywords : [],
        publisher: extra ? extra.publisher : '', evidence_count: extra ? extra.evidence_count : null,
        cover: extra && extra.cover ? extra.cover : null,
      };
    }

    function options() {
      return Array.from(select.options || []);
    }

    function selectedOption() {
      return options().find(option => option.value === select.value);
    }

    function close() {
      if (dialog.open) dialog.close();
    }

    function disableControls() {
      const disabled = Boolean(select.disabled);
      openButton.disabled = disabled;
      search.disabled = disabled;
      reset.disabled = disabled;
      retry.disabled = disabled || metadataState === 'loading';
      more.disabled = disabled;
      choiceButtons.forEach(button => { button.disabled = disabled; });
      categoryButtons.forEach(button => { button.disabled = disabled; });
      // Closing is always possible, including while the surrounding workflow is busy.
      closeButton.disabled = false;
    }

    function renderSummary() {
      const value = select.value;
      const source = currentSource(Number(value));
      summary.dataset.state = source ? 'selected' : value ? 'unavailable' : 'empty';
      if (source) {
        const title = element('p', 'source-selection-title', source.object_names[0] || source.title);
        const parts = [source.publisher, ...source.catalog_numbers];
        if (source.evidence_count !== null) parts.push(`${source.evidence_count} 条已审核证据`);
        summary.replaceChildren(title, element('p', 'source-selection-meta', parts.join(' · ') || source.title),
          element('p', 'source-selection-state', '已设为备用资料 · 全库未匹配时使用'));
      } else if (value) {
        summary.replaceChildren(
          element('p', 'source-selection-title', selectedOption()?.textContent || `已选择资料 #${value}`),
          element('p', 'source-selection-state', '当前不可用，请选择另一份可用资料后开始审阅。'));
      } else {
        summary.replaceChildren(element('p', 'source-selection-state', basic.size
          ? '还未选择备用资料。可按服饰名称、别名或馆藏编号查找。'
          : '资料就绪后，可在这里搜索并选择备用资料。'));
      }
      openButton.textContent = source || value ? '重新选择资料' : '查找并选择资料';
    }

    function commit(id) {
      // Baseline /api/sources remains the only authority for selectable identities.
      if (select.disabled || !basic.has(id) || !options().some(option => option.value === String(id))) return;
      if (select.value === String(id)) { close(); return; }
      select.value = String(id);
      if (select.value !== String(id)) return;
      onSelect();
      sync();
      close();
    }

    function renderChoice(source) {
      const li = element('li', 'source-choice');
      const main = element('div', 'source-choice-main');
      li.dataset.sourceId = String(source.id);
      li.dataset.selected = String(select.value === String(source.id));
      if (source.cover) {
        const image = element('img', 'source-choice-image');
        image.alt = source.cover.alt;
        image.width = source.cover.width;
        image.height = source.cover.height;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.addEventListener('error', () => { image.hidden = true; });
        image.src = source.cover.url;
        main.append(image);
      }
      const kind = CATEGORIES.find(item => item.key === categoryOf(source))?.title || '其他资料';
      main.append(element('span', 'source-choice-kind', kind),
        element('h3', 'source-choice-title', source.object_names[0] || source.title));
      if (source.title !== source.object_names[0]) main.append(element('p', 'source-choice-meta', source.title));
      if (source.object_names.length > 1) main.append(element('p', 'source-choice-meta', `涉及对象：${source.object_names.join('、')}`));
      if (source.publisher) main.append(element('p', 'source-choice-publisher', source.publisher));
      if (source.catalog_numbers.length) main.append(element('p', 'source-choice-meta', `馆藏编号：${source.catalog_numbers.join('、')}`));
      const aliases = unique(source.aliases).filter(alias => !/^MFB[0-9]+$/i.test(alias) && !source.object_names.includes(alias));
      if (aliases.length) main.append(element('p', 'source-choice-meta',
        `也称：${aliases.slice(0, 3).join('、')}${aliases.length > 3 ? ` · 另 ${aliases.length - 3} 个常用名` : ''}`));
      if (source.attributes.length) {
        const tags = element('div', 'source-choice-tags');
        tags.append(element('span', 'source-choice-tag-label', '可核对'));
        source.attributes.slice(0, 6).forEach(attribute => tags.append(element('span', '', attribute)));
        if (source.attributes.length > 6) tags.append(element('span', '', `另 ${source.attributes.length - 6} 项`));
        main.append(tags);
      }
      if (source.evidence_count !== null) main.append(element('p', 'source-choice-meta', `${source.evidence_count} 条已审核证据`));
      const actions = element('div', 'source-choice-actions');
      const use = element('button', 'primary-button', '设为备用资料');
      use.type = 'button';
      use.dataset.sourceId = String(source.id);
      use.setAttribute('aria-label', `设为备用资料：${source.object_names[0] || source.title}`);
      use.addEventListener('click', () => commit(source.id));
      choiceButtons.push(use);
      focusTargets.set(`use:${source.id}`, use);
      const detail = element('a', 'text-button', '查看资料 ↗');
      detail.href = `./source.html?id=${source.id}`;
      detail.target = '_blank';
      detail.rel = 'noopener noreferrer';
      detail.addEventListener('click', event => { if (select.disabled) event.preventDefault(); });
      focusTargets.set(`detail:${source.id}`, detail);
      actions.append(use, detail);
      main.append(actions);
      li.append(main);
      return li;
    }

    function render(preferredFocus = null) {
      let focusKey = preferredFocus;
      const focusedRetry = document.activeElement === retry;
      if (!focusKey) {
        for (const [key, target] of focusTargets) {
          if (target === document.activeElement) { focusKey = key; break; }
        }
      }
      focusTargets = new Map();
      choiceButtons = [];
      categoryButtons = [];
      const sources = [...basic.keys()].sort((left, right) => left - right).map(currentSource);
      const counts = new Map(CATEGORIES.map(item => [item.key, 0]));
      counts.set('other', 0);
      sources.forEach(source => { const key = categoryOf(source); counts.set(key, counts.get(key) + 1); });
      const categoryItems = [{ key: 'all', title: '全部', count: sources.length },
        ...CATEGORIES.map(item => ({ ...item, count: counts.get(item.key) }))];
      if (counts.get('other') > 0 || activeCategory === 'other') categoryItems.push({ key: 'other', title: '其他资料', count: counts.get('other') });
      categories.replaceChildren(...categoryItems.map(item => {
        const button = element('button', 'source-category', `${item.title} ${item.count}`);
        button.type = 'button';
        button.dataset.category = item.key;
        button.setAttribute('aria-pressed', String(item.key === activeCategory));
        button.addEventListener('click', () => {
          if (select.disabled) return;
          activeCategory = item.key;
          visibleLimit = 8;
          render(`category:${item.key}`);
        });
        categoryButtons.push(button);
        focusTargets.set(`category:${item.key}`, button);
        return button;
      }));
      const tokens = normalized(search.value).trim().split(/\s+/u).filter(Boolean);
      const filtered = sources.filter(source => {
        if (activeCategory !== 'all' && categoryOf(source) !== activeCategory) return false;
        const searchable = normalized([source.title, ...source.object_names, ...source.aliases,
          ...source.catalog_numbers, ...source.attributes, ...source.keywords, source.publisher].join(' '));
        return tokens.every(token => queryVariants(token).some(variant => searchable.includes(variant)));
      });
      const shown = filtered.slice(0, visibleLimit);
      list.replaceChildren(...shown.map(renderChoice));
      list.setAttribute('aria-busy', 'false');
      const supplement = metadataState === 'loading' ? ' · 正在补充别名与核对方面，现可按名称选择'
        : metadataState === 'error' ? ' · 扩展资料暂不可用，仍可按名称选择' : '';
      status.textContent = `找到 ${filtered.length} 份可用资料${shown.length < filtered.length ? ` · 已显示 ${shown.length} 份` : ''}${supplement}`;
      status.dataset.state = metadataState === 'error' ? 'partial' : metadataState === 'loading' ? 'loading' : 'ready';
      retry.hidden = metadataState !== 'error';
      reset.hidden = !tokens.length && activeCategory === 'all';
      more.hidden = shown.length >= filtered.length;
      more.textContent = `继续浏览 · 还有 ${Math.max(0, filtered.length - shown.length)} 份`;
      empty.hidden = filtered.length > 0;
      empty.textContent = sources.length ? '没有匹配资料。请换个名称、别名或馆藏编号，或清除筛选。' : '当前没有可选择的资料，请等待资料库连接。';
      disableControls();
      if (focusKey && dialog.open && !select.disabled) (focusTargets.get(focusKey) || search).focus();
      else if (focusedRetry && retry.hidden && dialog.open && !select.disabled) search.focus();
    }

    function sync() {
      const signature = JSON.stringify([select.value, Boolean(select.disabled), selectedOption()?.textContent || '', revision]);
      disableControls();
      if (select.disabled && dialog.open) close();
      if (signature === lastSyncSignature) return;
      lastSyncSignature = signature;
      renderSummary();
      if (dialog.open) render();
    }

    async function loadMetadata() {
      const generation = ++requestGeneration;
      activeController?.abort();
      if (!basic.size || disposed) return;
      const controller = new AbortController();
      activeController = controller;
      metadataState = 'loading';
      const timer = window.setTimeout(() => controller.abort(), 15000);
      if (dialog.open) render();
      disableControls();
      try {
        const response = await fetch('/api/library', { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('资料目录暂不可用');
        const data = await response.json();
        if (generation !== requestGeneration || disposed) return;
        if (controller.signal.aborted || !validLibrary(data)) throw new Error('资料目录格式异常');
        metadata = new Map(data.sources.filter(source => basic.has(source.id)).map(source => [source.id, source]));
        metadataState = 'ready';
      } catch {
        if (generation !== requestGeneration || disposed) return;
        metadataState = 'error';
      } finally {
        window.clearTimeout(timer);
        if (generation === requestGeneration && !disposed) {
          activeController = null;
          ++revision;
          sync();
        }
      }
    }

    function setSources(sources) {
      const next = new Map();
      if (Array.isArray(sources)) {
        for (const source of sources) {
          if (!source || !positiveId(source.id) || next.has(source.id)
            || typeof source.title !== 'string' || !source.title.trim() || typeof source.object_name !== 'string') {
            next.clear();
            break;
          }
          next.set(source.id, { id: source.id, title: source.title, object_name: source.object_name });
        }
      }
      const signature = JSON.stringify([...next.values()]);
      if (signature === baselineSignature) { sync(); return; }
      baselineSignature = signature;
      basic = next;
      metadata = new Map([...metadata].filter(([id]) => basic.has(id)));
      metadataState = 'idle';
      ++revision;
      sync();
      void loadMetadata();
    }

    function focus() {
      if (select.disabled) return;
      if (!dialog.open) {
        render();
        dialog.showModal();
      }
      search.focus();
    }

    openButton.addEventListener('click', focus);
    closeButton.addEventListener('click', close);
    dialog.addEventListener('close', () => { openButton.focus(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    search.addEventListener('input', () => {
      if (select.disabled) return;
      visibleLimit = 8;
      render();
    });
    search.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    dialog.addEventListener('submit', event => event.preventDefault());
    reset.addEventListener('click', () => {
      if (select.disabled) return;
      search.value = '';
      activeCategory = 'all';
      visibleLimit = 8;
      render();
      search.focus();
    });
    retry.addEventListener('click', () => {
      if (select.disabled || metadataState === 'loading') return;
      void loadMetadata();
    });
    more.addEventListener('click', () => {
      if (select.disabled) return;
      visibleLimit += 8;
      render();
      if (more.hidden) search.focus();
    });
    window.addEventListener('pagehide', () => {
      disposed = true;
      ++requestGeneration;
      activeController?.abort();
    });
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return;
      disposed = false;
      void loadMetadata();
    });

    nativeField.hidden = true;
    openButton.hidden = false;
    summary.hidden = false;
    sync();
    return Object.freeze({ setSources, sync, focus });
  }

  window.SourcePicker = Object.freeze({ create });
})();

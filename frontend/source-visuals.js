(() => {
  'use strict';

  const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
  const identity = value => (Number.isSafeInteger(value) && value > 0)
    || (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value));
  const localImage = value => typeof value === 'string'
    && /^\/img\/library\/[A-Za-z0-9][A-Za-z0-9_-]{0,159}\.(?:jpe?g|png|webp)$/i.test(value);
  const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 20000;
  function externalURL(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || value.length > 4096 || /[\s\\]/u.test(value)) return null;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  function validCover(cover) {
    return !!cover && typeof cover === 'object' && !Array.isArray(cover)
      && localImage(cover.url) && text(cover.alt, 1000) && dimension(cover.width) && dimension(cover.height);
  }
  function validCatalogVisual(source) {
    if (source.visual_count === undefined && source.cover === undefined) return true;
    return Number.isSafeInteger(source.visual_count) && source.visual_count >= 0 && source.visual_count <= 50
      && (source.visual_count === 0 ? source.cover === null : validCover(source.cover));
  }
  function validVisuals(visuals, evidenceIds) {
    if (visuals === undefined) return true;
    if (!Array.isArray(visuals) || visuals.length > 50) return false;
    const ids = new Set();
    for (const visual of visuals) {
      if (!validCover(visual) || !identity(visual.id) || ids.has(String(visual.id))
        || !externalURL(visual.original_url) || !text(visual.caption, 2000) || !text(visual.credit, 1000)
        || !Array.isArray(visual.hotspots) || visual.hotspots.length > 25) return false;
      ids.add(String(visual.id));
      const hotspotIds = new Set();
      for (const spot of visual.hotspots) {
        if (!spot || !identity(spot.id) || hotspotIds.has(String(spot.id)) || !text(spot.label, 200)
          || !Number.isFinite(spot.x) || spot.x < 0 || spot.x > 100
          || !Number.isFinite(spot.y) || spot.y < 0 || spot.y > 100
          || !Number.isSafeInteger(spot.evidence_id) || !evidenceIds.has(spot.evidence_id)) return false;
        hotspotIds.add(String(spot.id));
      }
    }
    return true;
  }
  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function button(className, content, handler) {
    const element = node('button', className, content);
    element.type = 'button';
    element.addEventListener('click', handler);
    return element;
  }
  function externalLink(url, label) {
    const link = node('a', 'visual-original-link', label);
    link.href = externalURL(url);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function render(host, visuals, evidence, actions) {
    host.replaceChildren();
    if (!visuals.length) {
      const empty = node('div', 'visual-empty');
      empty.append(node('strong', '', '本资料暂未收录配图'), node('p', '', '可以继续阅读下方的已审核证据，或通过原始出处查看馆方资料。'));
      host.append(empty);
      return;
    }

    const gallery = node('div', 'visual-gallery');
    const figure = node('figure', 'visual-figure');
    const frame = node('div', 'visual-frame');
    const imageStatus = node('p', 'visual-image-status');
    imageStatus.setAttribute('role', 'status');
    const caption = node('figcaption', 'visual-caption');
    const imageTools = node('div', 'visual-image-tools');
    const imageCounter = node('span', 'visual-counter');
    const enlarge = button('text-button', '放大查看 ↗', openLargeImage);
    imageTools.append(imageCounter, enlarge);
    figure.append(frame, imageStatus, imageTools, caption);

    const notes = node('div', 'visual-notes');
    const noteHeading = node('h3', '', '细节与原文');
    const noteList = node('ol', 'visual-note-list');
    noteList.setAttribute('aria-label', '配图标注');
    const selected = node('div', 'visual-selected-evidence');
    selected.setAttribute('aria-live', 'polite');
    selected.setAttribute('aria-atomic', 'true');
    notes.append(noteHeading, noteList, selected);
    gallery.append(figure, notes);
    const thumbnails = node('div', 'visual-thumbnails');
    thumbnails.setAttribute('role', 'group');
    thumbnails.setAttribute('aria-label', '切换资料配图');
    host.append(gallery, thumbnails);

    const dialog = node('dialog', 'visual-dialog');
    dialog.setAttribute('aria-label', '资料配图大图');
    const dialogTop = node('div', 'visual-dialog-top');
    const dialogTitle = node('h3', '', '资料配图');
    const close = button('secondary-button', '关闭大图', () => dialog.close());
    dialogTop.append(dialogTitle, close);
    const dialogBody = node('div', 'visual-dialog-body');
    dialog.append(dialogTop, dialogBody);
    dialog.addEventListener('close', () => { enlarge.focus(); });
    host.append(dialog);
    let activeIndex = 0;
    let activeGeneration = 0;
    let selectedSpot = null;
    let spotButtons = [];
    const thumbButtons = [];

    function openLargeImage() {
      if (enlarge.disabled) return;
      const visual = visuals[activeIndex];
      const largeImage = node('img');
      largeImage.alt = visual.alt;
      largeImage.width = visual.width;
      largeImage.height = visual.height;
      const message = node('p', 'visual-image-status', '正在读取大图…');
      message.setAttribute('role', 'status');
      largeImage.addEventListener('load', () => { message.hidden = true; });
      largeImage.addEventListener('error', () => {
        largeImage.hidden = true;
        message.hidden = false;
        message.textContent = '大图暂时无法读取，请关闭后重试，或查看原图。';
      });
      largeImage.src = visual.url;
      dialogTitle.textContent = `配图 ${activeIndex + 1} / ${visuals.length}`;
      dialogBody.replaceChildren(largeImage, message, node('p', 'visual-caption-text', visual.caption),
        node('p', 'visual-credit', visual.credit), externalLink(visual.original_url, '查看来源原图 ↗'));
      dialog.showModal();
      close.focus();
    }
    function selectSpot(spot) {
      selectedSpot = spot.id;
      for (const entry of spotButtons) entry.button.setAttribute('aria-pressed', String(entry.id === selectedSpot));
      const original = evidence.get(spot.evidence_id);
      const selectedTitle = node('p', 'visual-evidence-label', `${spot.label} · 对应原文`);
      const quote = node('blockquote', '', original.text);
      const links = node('div', 'visual-evidence-links');
      links.append(button('text-button', `查看证据 ${original.id} ↓`, () => actions.showEvidence(original)));
      if (actions.canLocate(original)) links.append(button('text-button', '定位原文 ↓', () => actions.locate(original)));
      else links.append(node('span', 'visual-credit', '原文位置待核对，可展开下方全文阅读。'));
      selected.replaceChildren(selectedTitle, quote, links);
    }
    function showImage(index) {
      activeIndex = index;
      const thisGeneration = ++activeGeneration;
      selectedSpot = null;
      spotButtons = [];
      const visual = visuals[index];
      frame.replaceChildren();
      noteList.replaceChildren();
      selected.replaceChildren(node('p', 'visual-select-hint', visual.hotspots.length
        ? '选择图片上的编号或上方标注，查看对应的已审核原文。'
        : '这幅配图尚未设置原文对照点，请结合下方证据阅读。'));
      imageCounter.textContent = `配图 ${index + 1} / ${visuals.length}`;
      thumbButtons.forEach((item, itemIndex) => item.setAttribute('aria-pressed', String(index === itemIndex)));
      caption.replaceChildren(node('p', 'visual-caption-text', visual.caption), node('p', 'visual-credit', visual.credit),
        externalLink(visual.original_url, '查看来源原图 ↗'));
      imageStatus.textContent = '正在读取配图…';
      imageStatus.hidden = false;
      enlarge.disabled = true;

      // The overlay shares the image's exact aspect ratio, including portrait views.
      const map = node('div', 'visual-image-map');
      map.style.aspectRatio = `${visual.width} / ${visual.height}`;
      map.style.width = `min(100%, ${Math.round(480 * visual.width / visual.height)}px)`;
      const mainImage = node('img', 'visual-main-image');
      mainImage.alt = visual.alt;
      mainImage.width = visual.width;
      mainImage.height = visual.height;
      mainImage.decoding = 'async';
      const markers = node('div', 'visual-markers');
      markers.hidden = true;
      visual.hotspots.forEach((spot, spotIndex) => {
        const marker = button('visual-marker', String(spotIndex + 1), () => selectSpot(spot));
        marker.style.left = `${spot.x}%`;
        marker.style.top = `${spot.y}%`;
        marker.setAttribute('aria-label', `${spotIndex + 1}. ${spot.label}，查看对应原文`);
        marker.setAttribute('aria-pressed', 'false');
        markers.append(marker);
        const li = node('li');
        const noteButton = button('visual-note-button', '', () => selectSpot(spot));
        noteButton.append(node('span', 'visual-note-number', String(spotIndex + 1)), node('span', '', spot.label));
        noteButton.setAttribute('aria-pressed', 'false');
        li.append(noteButton);
        noteList.append(li);
        spotButtons.push({ id: spot.id, button: marker }, { id: spot.id, button: noteButton });
      });
      mainImage.addEventListener('load', () => {
        if (thisGeneration !== activeGeneration) return;
        // Refuse mismatched metadata rather than placing misleading hotspots.
        const correctRatio = mainImage.naturalWidth > 0 && mainImage.naturalHeight > 0
          && Math.abs(mainImage.naturalWidth / mainImage.naturalHeight - visual.width / visual.height) < 0.01;
        if (!correctRatio) { imageFailure('配图尺寸与资料记录不一致，已隐藏标注，请查看来源原图。'); return; }
        markers.hidden = false;
        imageStatus.hidden = true;
        enlarge.disabled = false;
      });
      function imageFailure(message) {
        if (thisGeneration !== activeGeneration) return;
        markers.hidden = true;
        map.hidden = true;
        enlarge.disabled = true;
        imageStatus.hidden = false;
        imageStatus.textContent = message;
        const retry = button('secondary-button', '重新读取配图', () => showImage(index));
        frame.replaceChildren(node('span', 'visual-error-symbol', '图'), retry,
          externalLink(visual.original_url, '查看来源原图 ↗'));
      }
      mainImage.addEventListener('error', () => imageFailure('配图暂时无法读取。仍可通过右侧标注阅读资料原文。'));
      map.append(mainImage, markers);
      frame.append(map);
      mainImage.src = visual.url;
    }
    visuals.forEach((visual, index) => {
      const thumb = button('visual-thumbnail', '', () => showImage(index));
      thumb.setAttribute('aria-label', `查看第 ${index + 1} 幅配图：${visual.caption}`);
      thumb.setAttribute('aria-pressed', 'false');
      const img = node('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = visual.width;
      img.height = visual.height;
      img.addEventListener('error', () => { img.hidden = true; });
      img.src = visual.url;
      thumb.append(img, node('span', '', `配图 ${index + 1}`));
      thumbnails.append(thumb);
      thumbButtons.push(thumb);
    });
    showImage(0);
  }

  window.SourceVisuals = Object.freeze({ validCatalogVisual, validVisuals, render });
})();

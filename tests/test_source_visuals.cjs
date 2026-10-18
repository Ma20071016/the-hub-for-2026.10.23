/* UI behavior and untrusted-media validation; uses isolated synthetic fixtures.
 * Run: node tests/test_source_visuals.cjs
 * Does not write source records or access the application/browser/network.
 */
const assert = require('node:assert/strict');
const { page, catalog, detail, settle, descendants, clone, visibleIds, anchors, buttons } = require('./test_library_frontend.cjs');
const visual = {
  id: 'robe-front', url: '/img/library/robe-front.jpg', original_url: 'https://example.invalid/images/robe.jpg',
  caption: '示例服饰正面图', alt: '示例服饰的完整正面', width: 600, height: 900, credit: '示例馆藏配图，仅用于界面测试',
  hotspots: [{ id: 'neck', label: '领口', x: 50, y: 22, evidence_id: 12 }, { id: 'cloth', label: '材质', x: 30, y: 60, evidence_id: 11 }],
};
const sourceData = () => ({ ...clone(detail), visuals: [clone(visual), { ...clone(visual), id: 'wide-view', url: '/img/library/cloth.webp', width: 2000, height: 428, caption: '示例横向配图', hotspots: [] }] });
const catalogData = () => {
  const data = clone(catalog);
  data.sources.forEach(source => { source.visual_count = 0; source.cover = null; });
  data.sources[0].visual_count = 2;
  data.sources[0].cover = { url: visual.url, alt: visual.alt, width: visual.width, height: visual.height };
  return data;
};
const css = (node, name) => descendants(node, child => child.className.split(' ').includes(name));
const one = (node, name) => { const all = css(node, name); assert.equal(all.length, 1, name); return all[0]; };
const loadedImage = (host, width = visual.width, height = visual.height) => {
  const img = one(host, 'visual-main-image'); img.naturalWidth = width; img.naturalHeight = height; img.events.load({}); return img;
};
const openSource = async (data = sourceData(), url = '/source.html?id=1') => {
  const source = page('source', url, data); source.start(); await settle(); return source;
};

(async () => {
  // 1. Old API responses and real empty media inventories remain usable.
  for (const data of [clone(detail), { ...clone(detail), visuals: [] }]) {
    const source = await openSource(data);
    assert.equal(source.get('source-content').hidden, false);
    assert.match(source.get('source-visuals').textContent, /暂未收录配图/);
    assert.equal(css(source.get('source-visuals'), 'visual-main-image').length, 0);
    assert.equal(source.get('source-visual-title').textContent, '文献资料');
    assert.equal(source.get('source-visual-kind').textContent, '原文与证据');
    assert.match(source.get('source-visual-intro').textContent, /暂未收录馆藏配图/);
    assert.doesNotMatch(source.get('source-visual-intro').textContent, /选择.*编号/);
    assert.equal(source.get('source-visual-note').hidden, true);
  }

  // 2. Image-only selection composes with existing search, persists in links and clears.
  const library = page('library', '/library.html?images=1&q=棉袍&attribute=材质&publisher=示例馆一', catalogData());
  library.start(); await settle();
  assert.deepEqual(visibleIds(library), [1]);
  assert.equal(library.get('library-images').checked, true);
  assert.match(library.get('library-list').textContent, /2 幅配图/);
  const href = anchors(library.get('library-list'))[0].href;
  assert.equal(new URL(href, 'http://localhost').searchParams.get('images'), '1');
  const linked = await openSource(sourceData(), href);
  assert.equal(new URL(linked.get('source-back').href, 'http://localhost').searchParams.get('images'), '1');
  library.get('library-reset').click();
  assert.equal(library.get('library-images').checked, false);
  assert.equal(library.get('library-list').children.length, 12);
  assert.equal(library.location.search, '');

  // 3. Card covers preserve complete objects and fail with a readable fallback.
  const preview = one(library.get('library-list'), 'library-card-preview');
  const cover = descendants(preview, child => child.tagName === 'img')[0];
  assert.equal(cover.alt, visual.alt); assert.equal(cover.loading, 'lazy');
  cover.events.error({});
  assert.match(preview.textContent, /配图暂不可用/);

  // 4. Initial image load exposes no floating annotations; dimensions anchor percentages.
  const source = await openSource();
  const host = source.get('source-visuals');
  assert.equal(source.get('source-content').hidden, false);
  assert.equal(source.get('source-visual-title').textContent, '近观藏品');
  assert.equal(source.get('source-visual-kind').textContent, '馆藏影像 · 图文对读');
  assert.match(source.get('source-visual-intro').textContent, /设有编号/);
  assert.equal(source.get('source-visual-note').hidden, false);
  assert.equal(one(host, 'visual-markers').hidden, true);
  assert.equal(one(host, 'visual-image-map').style.aspectRatio, '600 / 900');
  assert.equal(one(host, 'visual-image-map').style.width, 'min(100%, 320px)');
  loadedImage(host);
  assert.equal(one(host, 'visual-markers').hidden, false);
  const markers = css(host, 'visual-marker');
  assert.equal(markers[0].style.left, '50%'); assert.equal(markers[0].style.top, '22%');
  assert.match(markers[0].getAttribute('aria-label'), /领口/);

  // 5. Image buttons and text list show the exact same approved evidence and state.
  markers[0].click();
  let quote = one(host, 'visual-selected-evidence');
  assert.match(quote.textContent, /采用对襟设计。/);
  assert.equal(markers[0].getAttribute('aria-pressed'), 'true');
  assert.equal(css(host, 'visual-note-button')[0].getAttribute('aria-pressed'), 'true');
  css(host, 'visual-note-button')[1].click();
  assert.match(quote.textContent, /棉袍使用棉布。/);
  assert.equal(markers[0].getAttribute('aria-pressed'), 'false');
  assert.equal(markers[1].getAttribute('aria-pressed'), 'true');

  // 6. Both evidence-card and Unicode original-text destinations remain correct.
  buttons(quote).find(item => item.textContent.startsWith('查看证据')).click();
  assert.equal(source.get('evidence-11').focused, true);
  assert.equal(source.get('evidence-11').scrolledIntoView, true);
  buttons(quote).find(item => item.textContent.startsWith('定位原文')).click();
  assert.equal(source.get('source-active-evidence').textContent, detail.evidence[0].text);
  assert.equal(source.get('source-original').textContent, detail.source.original_text);

  // 7. A picture change clears the selected evidence and handles extreme wide images.
  css(host, 'visual-thumbnail')[1].click();
  assert.match(one(host, 'visual-selected-evidence').textContent, /尚未设置原文对照点/);
  assert.equal(css(host, 'visual-marker').length, 0);
  assert.equal(one(host, 'visual-image-map').style.aspectRatio, '2000 / 428');
  loadedImage(host, 2000, 428);
  assert.equal(css(host, 'visual-thumbnail')[1].getAttribute('aria-pressed'), 'true');
  css(host, 'visual-thumbnail')[0].click();
  assert.match(one(host, 'visual-selected-evidence').textContent, /选择图片上的编号/);
  assert.equal(css(host, 'visual-marker')[0].getAttribute('aria-pressed'), 'false');

  // 8. Failed media never leaves hotspots over an absent picture; retry can recover.
  one(host, 'visual-main-image').events.error({});
  assert.equal(css(host, 'visual-marker').length, 0);
  assert.match(one(host, 'visual-image-status').textContent, /暂时无法读取/);
  buttons(host).find(item => item.textContent === '重新读取配图').click();
  loadedImage(host);
  assert.equal(one(host, 'visual-markers').hidden, false);

  // 9. Bad dimensions and stale image events cannot place markers on the wrong image.
  const oldImage = one(host, 'visual-main-image');
  css(host, 'visual-thumbnail')[1].click();
  oldImage.events.error({});
  assert.equal(one(host, 'visual-image-map').style.aspectRatio, '2000 / 428');
  loadedImage(host, 600, 900);
  assert.match(one(host, 'visual-image-status').textContent, /尺寸与资料记录不一致/);
  assert.equal(css(host, 'visual-marker').length, 0);

  // 10. Native dialog supports button/ESC close, accessible naming and focus return.
  css(host, 'visual-thumbnail')[0].click(); loadedImage(host);
  const enlarge = buttons(host).find(item => item.textContent === '放大查看 ↗');
  enlarge.click();
  const dialog = one(host, 'visual-dialog');
  assert.equal(dialog.open, true); assert.equal(dialog.getAttribute('aria-label'), '资料配图大图');
  assert.equal(buttons(dialog)[0].focused, true);
  buttons(dialog)[0].click(); assert.equal(dialog.open, false); assert.equal(enlarge.focused, true);
  enlarge.click(); dialog.close(); assert.equal(enlarge.focused, true); // native ESC dispatches close
  const origin = anchors(host).filter(item => item.href === visual.original_url);
  assert.ok(origin.length > 0);
  assert.ok(origin.every(item => item.target === '_blank' && item.rel === 'noopener noreferrer'));

  // 11. Unverified evidence still reads, but no false original-text jump is offered.
  const unlocatedData = sourceData(); unlocatedData.evidence[1].locator_verified = false;
  const unlocated = await openSource(unlocatedData);
  const unlocatedHost = unlocated.get('source-visuals');
  css(unlocatedHost, 'visual-note-button')[0].click();
  assert.equal(buttons(one(unlocatedHost, 'visual-selected-evidence')).length, 1);
  assert.match(one(unlocatedHost, 'visual-selected-evidence').textContent, /原文位置待核对/);

  // 12. Corrupt media/annotation data is rejected before any unsafe DOM URL is assigned.
  const corruptions = [
    data => { data.visuals = null; }, data => { data.visuals[0].id = '../unsafe'; },
    data => { data.visuals[0].url = 'https://evil.invalid/robe.jpg'; },
    data => { data.visuals[0].url = '/img/library/../robe.jpg'; },
    data => { data.visuals[0].url = '/img/library/%2e%2e.png'; },
    data => { data.visuals[0].url = '/img/library/robe.svg'; },
    data => { data.visuals[0].url += '?cache=1'; },
    data => { data.visuals[0].original_url = 'javascript:alert(1)'; },
    data => { data.visuals[0].original_url = '//example.invalid/image.jpg'; },
    data => { data.visuals[0].original_url = 'https://user:password@example.invalid/image.jpg'; },
    data => { data.visuals[0].width = 0; }, data => { data.visuals[0].height = '900'; },
    data => { data.visuals[0].caption = ''; }, data => { data.visuals[0].credit = ''; },
    data => { data.visuals[0].hotspots[0].x = -1; }, data => { data.visuals[0].hotspots[0].y = 101; },
    data => { data.visuals[0].hotspots[0].x = '50'; },
    data => { data.visuals[0].hotspots[0].evidence_id = 9999; },
    data => { data.visuals[0].hotspots[0].evidence_id = '12'; },
    data => { data.visuals[1].id = data.visuals[0].id; },
    data => { data.visuals[0].hotspots[1].id = data.visuals[0].hotspots[0].id; },
  ];
  for (const corrupt of corruptions) {
    const data = sourceData(); corrupt(data);
    const rejected = await openSource(data);
    assert.equal(rejected.get('source-content').hidden, true);
    assert.equal(rejected.get('source-status').dataset.state, 'error');
  }

  // 13. Inconsistent catalog media cannot claim images or render unsafe thumbnails.
  for (const corrupt of [
    data => { data.sources[0].visual_count = -1; }, data => { data.sources[0].visual_count = 0; },
    data => { data.sources[0].cover = null; }, data => { data.sources[0].cover.url = 'data:image/png,x'; },
    data => { data.sources[0].cover.width = 0; }, data => { delete data.sources[0].visual_count; },
  ]) {
    const data = catalogData(); corrupt(data);
    const rejected = page('library', '/library.html', data); rejected.start(); await settle();
    assert.equal(rejected.get('library-status').dataset.state, 'error');
    assert.equal(rejected.get('library-list').children.length, 0);
  }

  // 14. Captions and evidence labels are text, never injected markup.
  const escapedData = sourceData();
  escapedData.visuals[0].caption = '<img src=x onerror=alert(1)>';
  escapedData.visuals[0].hotspots[0].label = '<script>alert(1)</script>';
  const escaped = await openSource(escapedData);
  assert.match(escaped.get('source-visuals').textContent, /<img src=x/);
  assert.equal(descendants(escaped.get('source-visuals'), item => item.tagName === 'script').length, 0);
  // 15. Unannotated images and reloads describe only the available reading tools.
  const unannotatedData = sourceData();
  unannotatedData.visuals.forEach(item => { item.hotspots = []; });
  const unannotated = await openSource(unannotatedData);
  assert.equal(unannotated.get('source-visual-title').textContent, '近观藏品');
  assert.equal(unannotated.get('source-visual-kind').textContent, '馆藏影像 · 图文对读');
  assert.match(unannotated.get('source-visual-intro').textContent, /浏览馆藏配图/);
  assert.doesNotMatch(unannotated.get('source-visual-intro').textContent, /编号|标注/);
  assert.equal(unannotated.get('source-visual-note').hidden, true);
  assert.equal(css(unannotated.get('source-visuals'), 'visual-marker').length, 0);
  unannotated.respond(clone(detail)); await unannotated.get('source-retry').click();
  assert.equal(unannotated.get('source-visual-title').textContent, '文献资料');
  assert.equal(unannotated.get('source-visual-note').hidden, true);
  unannotated.respond(sourceData()); await unannotated.get('source-retry').click();
  assert.equal(unannotated.get('source-visual-title').textContent, '近观藏品');
  assert.match(unannotated.get('source-visual-intro').textContent, /设有编号/);
  assert.equal(unannotated.get('source-visual-note').hidden, false);
  console.log('PASS: 15 source-visual scenarios, including approved-evidence navigation, safe media, filtering, ratio anchoring, loading/retry, honest guide copy and dialog focus');
})().catch(error => { console.error(error); process.exitCode = 1; });

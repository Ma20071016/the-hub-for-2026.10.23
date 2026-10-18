/* Museum catalog interactions with isolated API-shaped fixtures.
 * Run: node tests/test_museum_library.cjs
 * No network, database writes, or real history records are involved.
 */
const assert = require('node:assert/strict');
const { page, catalog, settle, descendants, clone, visibleIds } = require('./test_library_frontend.cjs');

const dataWithImages = () => {
  const data = clone(catalog);
  data.sources.forEach(source => { source.visual_count = 0; source.cover = null; });
  for (const [index, width, height] of [[0, 1600, 1202], [2, 1600, 342], [4, 1298, 1600]]) {
    data.sources[index].visual_count = index === 4 ? 1 : 2;
    data.sources[index].cover = {
      url: `/img/library/fixture-${index}.jpg`, alt: `界面测试配图 ${index + 1}`, width, height,
    };
  }
  return data;
};
const css = (host, name) => descendants(host, node => node.className.split(' ').includes(name));
const one = (host, name) => {
  const found = css(host, name);
  assert.equal(found.length, 1, name);
  return found[0];
};
const media = library => library.get('museum-feature-media');
const featureImage = library => one(media(library), 'museum-feature-image');
const featureStatus = library => one(media(library), 'museum-feature-image-status');
const featureURL = library => new URL(library.get('museum-feature-link').href, 'http://localhost');
const open = async (data = dataWithImages(), address = '/library.html', status = 200) => {
  const library = page('library', address, data, status);
  library.start(); await settle(); return library;
};

(async () => {
  // 1. A real cover is selected without changing catalog/evidence totals or pagination.
  const library = await open();
  assert.deepEqual(library.requests, ['/api/library']);
  assert.equal(library.get('museum-feature').hidden, false);
  assert.equal(library.get('museum-feature-title').textContent, catalog.sources[0].title);
  assert.equal(library.get('museum-feature-publisher').textContent, catalog.sources[0].publisher);
  assert.equal(library.get('museum-feature-excerpt').textContent, catalog.sources[0].excerpt);
  assert.equal(library.get('museum-feature-number').textContent, '资料 001');
  assert.equal(library.get('museum-feature-position').textContent, '1 / 3 · 示例棉袍');
  assert.equal(library.get('museum-feature-position').getAttribute('aria-atomic'), 'true');
  assert.equal(featureURL(library).searchParams.get('id'), '1');
  assert.equal(featureImage(library).alt, '界面测试配图 1');
  assert.equal(featureImage(library).width, 1600);
  assert.equal(featureImage(library).height, 1202);
  assert.equal(featureStatus(library).getAttribute('role'), 'status');
  assert.equal(library.get('source-total').textContent, '13');
  assert.equal(library.get('evidence-total').textContent, '14');
  assert.equal(library.get('library-list').children.length, 12);
  assert.equal(css(library.get('library-list'), 'library-card-preview').length, 3);
  assert.equal(css(library.get('library-list'), 'library-card-archive').length, 9);
  assert.ok(css(library.get('library-list'), 'library-card-archive').every(card => card.getAttribute('aria-hidden') === 'true'));
  library.get('library-more').click();
  assert.deepEqual(visibleIds(library), catalog.sources.map(source => source.id));
  assert.equal(css(library.get('library-list'), 'library-card-archive').length, 10);

  // 2. Navigation cycles manually through covers, preserving wide/tall dimensions.
  const timed = page('library', '/library.html', dataWithImages());
  const timerDelays = [];
  const originalSetTimeout = timed.window.setTimeout;
  timed.window.setTimeout = (callback, delay) => {
    timerDelays.push(delay); return originalSetTimeout(callback, delay);
  };
  timed.start(); await settle();
  const next = timed.get('museum-feature-next');
  const previous = timed.get('museum-feature-previous');
  assert.equal(next.disabled, false); assert.equal(previous.disabled, false);
  next.click();
  assert.equal(featureURL(timed).searchParams.get('id'), '3');
  assert.equal(featureImage(timed).width, 1600); assert.equal(featureImage(timed).height, 342);
  next.click();
  assert.equal(featureURL(timed).searchParams.get('id'), '5');
  assert.equal(featureImage(timed).width, 1298); assert.equal(featureImage(timed).height, 1600);
  next.click(); assert.equal(featureURL(timed).searchParams.get('id'), '1');
  previous.click(); assert.equal(featureURL(timed).searchParams.get('id'), '5');
  assert.equal(timed.get('museum-feature-position').textContent, '3 / 3 · 服饰资料 5');
  assert.deepEqual(timerDelays, [15000, 12000], 'Only the API and background-image timeouts may be scheduled; the featured exhibit never auto-advances.');
  timed.expireRequests();
  assert.equal(featureURL(timed).searchParams.get('id'), '5');

  // 3. The featured exhibit stays independent; its detail link retains all catalog filters.
  const filtered = await open(dataWithImages(), '/library.html?q=棉袍&attribute=材质&publisher=示例馆一&images=1');
  assert.deepEqual(visibleIds(filtered), [1]);
  const originalImage = featureImage(filtered);
  const originalBackdrop = filtered.get('museum-backdrop-stage').firstElementChild;
  filtered.edit('library-search', '不存在的藏品');
  assert.deepEqual(visibleIds(filtered), []);
  assert.equal(filtered.get('library-empty').hidden, false);
  assert.equal(filtered.get('museum-feature').hidden, false);
  assert.equal(featureImage(filtered), originalImage, 'Filtering must not restart the featured image load.');
  assert.equal(filtered.get('museum-backdrop-stage').firstElementChild, originalBackdrop, 'Filtering must not restart the independent backdrop.');
  assert.equal(filtered.get('museum-feature-position').textContent, '1 / 3 · 示例棉袍');
  assert.equal(filtered.get('source-total').textContent, '13');
  for (const [key, value] of [['q', '不存在的藏品'], ['attribute', '材质'], ['publisher', '示例馆一'], ['images', '1']]) {
    assert.equal(featureURL(filtered).searchParams.get(key), value);
  }
  filtered.get('museum-feature-next').click();
  assert.equal(filtered.get('museum-backdrop-stage').firstElementChild, originalBackdrop, 'Featured exhibit navigation must not move the backdrop.');
  assert.equal(featureURL(filtered).searchParams.get('id'), '3');
  assert.equal(featureURL(filtered).searchParams.get('q'), '不存在的藏品');
  filtered.get('library-reset').click();
  assert.equal(featureURL(filtered).search, '?id=3');
  assert.equal(filtered.get('library-list').children.length, 12);

  // 4. Empty/legacy catalogs never invent exhibits; one cover cannot rotate.
  const withoutImages = dataWithImages();
  withoutImages.sources.forEach(source => { source.cover = null; source.visual_count = 0; });
  const emptyCatalog = { sources: [], attributes: [], publishers: [], stats: { available_sources: 0, approved_evidence: 0 } };
  for (const data of [catalog, withoutImages, emptyCatalog]) {
    const empty = await open(data);
    assert.equal(empty.get('museum-feature').hidden, true);
    assert.equal(media(empty).children.length, 0);
    assert.equal(empty.get('library-status').dataset.state, 'ready');
    assert.equal(empty.get('source-total').textContent, String(data.sources.length));
  }
  const singleData = dataWithImages();
  singleData.sources.slice(1).forEach(source => { source.cover = null; source.visual_count = 0; });
  singleData.sources[0].publisher = ''; singleData.sources[0].excerpt = ' ';
  const single = await open(singleData);
  assert.equal(single.get('museum-feature-position').textContent, '1 / 1 · 示例棉袍');
  assert.equal(single.get('museum-feature-previous').disabled, true);
  assert.equal(single.get('museum-feature-next').disabled, true);
  assert.equal(single.get('museum-feature-excerpt').hidden, true);
  assert.equal(single.get('museum-feature-publisher').textContent, '机构未注明');

  // 5. Failed or late image events cannot replace the current exhibit or its link.
  const errors = await open();
  const staleImage = featureImage(errors);
  errors.get('museum-feature-next').click();
  const currentImage = featureImage(errors);
  staleImage.events.error({}); staleImage.events.load({});
  assert.equal(featureImage(errors), currentImage);
  assert.equal(currentImage.hidden, false);
  assert.match(featureStatus(errors).textContent, /正在读取/);
  currentImage.events.error({});
  assert.equal(currentImage.hidden, true);
  assert.equal(featureStatus(errors).hidden, false);
  assert.match(featureStatus(errors).textContent, /配图暂不可用/);
  assert.equal(featureURL(errors).searchParams.get('id'), '3');
  assert.equal(errors.get('museum-feature-position').textContent, '2 / 3 · 服饰资料 3');
  errors.get('museum-feature-next').click();
  featureImage(errors).events.load({});
  assert.equal(featureStatus(errors).hidden, true);
  assert.equal(featureImage(errors).hidden, false);

  // 6. Reload failures hide stale exhibits; retry reuses a fresh valid catalog.
  errors.stall();
  const pending = errors.get('library-retry').click();
  assert.equal(errors.get('museum-feature').hidden, true);
  assert.equal(media(errors).children.length, 0);
  errors.expireRequests(); await pending;
  assert.equal(errors.get('library-status').dataset.state, 'error');
  assert.equal(errors.get('museum-feature').hidden, true);
  errors.respond(singleData); await errors.get('library-retry').click();
  assert.equal(errors.get('museum-feature').hidden, false);
  assert.equal(errors.get('museum-feature-position').textContent, '1 / 1 · 示例棉袍');
  const unavailable = await open(dataWithImages(), '/library.html', 503);
  assert.equal(unavailable.get('museum-feature').hidden, true);
  assert.equal(media(unavailable).children.length, 0);

  // 7. Unsafe media and inconsistent counts are rejected before a hero is rendered.
  for (const mutate of [
    data => { data.sources[0].cover.url = 'javascript:alert(1)'; },
    data => { data.sources[0].cover.url = 'https://example.invalid/robe.jpg'; },
    data => { data.sources[0].cover.url = '/img/library/../robe.jpg'; },
    data => { data.sources[0].cover.width = 0; },
    data => { data.sources[0].visual_count = 0; },
    data => { data.stats.available_sources += 1; },
    data => { data.stats.approved_evidence += 1; },
  ]) {
    const data = dataWithImages(); mutate(data);
    const rejected = await open(data);
    assert.equal(rejected.get('library-status').dataset.state, 'error');
    assert.equal(rejected.get('museum-feature').hidden, true);
    assert.equal(media(rejected).children.length, 0);
    assert.equal(rejected.get('source-total').textContent, '—');
  }

  // 8. Museum labels remain plain text, including untrusted titles and excerpts.
  const escapedData = dataWithImages();
  escapedData.sources[0].title = '<img src=x onerror=alert(1)>';
  escapedData.sources[0].publisher = '<script>alert(1)</script>';
  escapedData.sources[0].excerpt = '<a href="javascript:alert(1)">原文</a>';
  const escaped = await open(escapedData);
  for (const [id, key] of [['museum-feature-title', 'title'], ['museum-feature-publisher', 'publisher'], ['museum-feature-excerpt', 'excerpt']]) {
    assert.equal(escaped.get(id).textContent, escapedData.sources[0][key]);
    assert.equal(escaped.get(id).children.length, 0);
  }
  assert.equal(featureURL(escaped).pathname, '/source.html');
  assert.equal(featureURL(escaped).searchParams.get('id'), '1');
  assert.equal(escaped.get('museum-feature-position').textContent, '1 / 3 · <img src=x onerror=alert(1)>');
  assert.equal(escaped.get('museum-feature-position').children.length, 0);

  // 9. All orbit panels remain independent from the featured exhibit and catalog filters.
  const orbitData = clone(catalog);
  for (const source of orbitData.sources) {
    const allowed = [1, 2, 4, 7].includes(source.id);
    source.visual_count = allowed ? 1 : 0;
    source.cover = allowed ? { url: `/img/library/orbit-${source.id}.jpg`, alt: `测试服饰 ${source.id}`, width: 900, height: 1200 } : null;
  }
  const orbit = await open(orbitData);
  const orbitStage = orbit.get('museum-backdrop-stage');
  const orbitCards = [...orbitStage.children];
  const orbitImages = descendants(orbitStage, node => node.tagName === 'img');
  assert.deepEqual(orbitCards.map(card => Number(card.dataset.sourceId)), [1, 2, 4, 7]);
  assert.equal(orbitImages.length, 4);
  orbitImages.forEach(image => image.events.load({}));
  const initialFeatureImage = featureImage(orbit);
  orbit.get('museum-backdrop-next').click();
  assert.equal(orbit.get('museum-backdrop-link').href, './source.html?id=2');
  assert.equal(orbit.get('museum-backdrop-position').textContent, '02 / 04');
  assert.equal(featureImage(orbit), initialFeatureImage);
  assert.equal(featureURL(orbit).searchParams.get('id'), '1');
  orbit.get('museum-feature-next').click();
  orbit.get('museum-feature-next').click();
  assert.equal(featureURL(orbit).searchParams.get('id'), '4');
  assert.equal(orbit.get('museum-backdrop-link').href, './source.html?id=2');
  const rotation = orbitStage.dataset.rotation;
  orbit.edit('library-search', '不存在的服饰');
  assert.equal(orbit.get('library-empty').hidden, false);
  assert.equal(orbitStage.dataset.rotation, rotation);
  assert.deepEqual(orbitStage.children, orbitCards);
  assert.deepEqual(descendants(orbitStage, node => node.tagName === 'img'), orbitImages);
  assert.deepEqual(orbit.requests, ['/api/library'], 'Orbit controls and filters must not request the catalog again.');
  console.log('PASS: 9 museum catalog scenarios, including manual navigation, truthful counts, filter preservation, empty/error recovery, stale media, safe text and independent orbit panels');
})().catch(error => { console.error(error); process.exitCode = 1; });

(() => {
  'use strict';
  window.MuseumBackdrop = { create };
  function create() {
    const byId = id => document.getElementById(id);
    const stage = byId('museum-backdrop-stage');
    const controls = byId('museum-backdrop-controls');
    const toggle = byId('museum-backdrop-toggle');
    const previous = byId('museum-backdrop-previous');
    const next = byId('museum-backdrop-next');
    const title = byId('museum-backdrop-title');
    const position = byId('museum-backdrop-position');
    const link = byId('museum-backdrop-link');
    const hero = byId('museum-intro');
    if (![stage, controls, toggle, previous, next, title, position, link, hero].every(Boolean)) return null;
    const motion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: true };
    const hasFrames = typeof window.requestAnimationFrame === 'function'
      && typeof window.cancelAnimationFrame === 'function';
    const allowed = new Set([1, 2, 4, 7]);
    const revolution = 72000;
    let records = [], visible = [], angle = 0, activeId = null, generation = 0;
    let frame = null, frameGeneration = 0, lastTime = null, manual = null;
    let userPaused = false, inView = false, focused = false, suspended = false, detailFocused = false;
    const modulo = (value, length) => ((value % length) + length) % length;
    const frontIndex = () => visible.length ? modulo(Math.round(-angle / (360 / visible.length)), visible.length) : -1;
    const canAnimate = () => hasFrames && !motion.matches && inView && !document.hidden && !suspended && !detailFocused;
    const autoplay = () => visible.length > 1 && canAnimate() && !userPaused && !focused;

    function stopFrame() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null; lastTime = null; ++frameGeneration;
    }
    function render() {
      const front = frontIndex();
      stage.dataset.rotation = String(angle);
      visible.forEach((record, i) => {
        const radians = (angle + i * 360 / visible.length) * Math.PI / 180;
        const x = Math.sin(radians), z = Math.cos(radians);
        const proximity = (z + 1) / 2;
        // Position, depth and viewing angle all follow the same ellipse.
        // Panels face inward slightly, keeping source photographs unmirrored.
        const style = record.card.style;
        style.setProperty('--orbit-x', x.toFixed(5));
        style.setProperty('--orbit-z', z.toFixed(5));
        style.setProperty('--orbit-lift', (1 - proximity).toFixed(5));
        style.setProperty('--orbit-yaw', (x * 62).toFixed(3) + 'deg');
        style.setProperty('--orbit-shade', ((1 - proximity) * .54).toFixed(4));
        record.card.dataset.front = String(i === front);
      });
      if (front < 0) return;
      const current = visible[front].source;
      if (activeId !== current.id) {
        activeId = current.id;
        title.textContent = current.object_names?.[0] || current.title;
        link.href = './source.html?id=' + current.id;
      }
      const label = String(front + 1).padStart(2, '0') + ' / ' + String(visible.length).padStart(2, '0');
      if (position.textContent !== label) position.textContent = label;
    }
    function tick(timestamp, token) {
      if (token !== frameGeneration) return;
      frame = null;
      // Restart the clock after pauses so a suspended tab never jumps ahead.
      const delta = lastTime === null ? 0 : Math.min(64, Math.max(0, timestamp - lastTime));
      lastTime = timestamp;
      if (manual) {
        manual.elapsed += delta;
        const progress = Math.min(1, manual.elapsed / 1200);
        angle = manual.from + (manual.to - manual.from) * (1 - Math.pow(1 - progress, 3));
        if (progress === 1) manual = null;
      } else if (autoplay()) {
        angle = (angle - delta * 360 / revolution) % 360;
      }
      render(); scheduleFrame();
    }
    function sync() {
      const multiple = visible.length > 1;
      previous.disabled = next.disabled = !multiple;
      toggle.disabled = !multiple || motion.matches || !hasFrames;
      toggle.textContent = motion.matches || !hasFrames ? '静态浏览' : userPaused ? '继续旋转' : '暂停旋转';
      toggle.setAttribute('aria-pressed', String(userPaused || motion.matches || !hasFrames));
      toggle.title = motion.matches ? '已遵循系统减少动态效果设置，仍可手动切换' : '';
      scheduleFrame();
    }
    function scheduleFrame() {
      const playing = autoplay();
      const moving = Boolean(manual && canAnimate()) || playing;
      if (stage.dataset.playing !== String(playing)) stage.dataset.playing = String(playing);
      if (stage.dataset.moving !== String(moving)) stage.dataset.moving = String(moving);
      if (moving) {
        if (frame === null) {
          const token = frameGeneration;
          frame = window.requestAnimationFrame(time => tick(time, token));
        }
      } else stopFrame();
    }
    function arrange() {
      const oldFront = visible[frontIndex()];
      const oldPosition = oldFront ? angle + visible.indexOf(oldFront) * 360 / visible.length : 0;
      visible = records.filter(record => record.status === 'ready');
      const retained = visible.indexOf(oldFront);
      angle = retained >= 0 ? oldPosition - retained * 360 / visible.length : 0;
      manual = null;
      controls.hidden = link.hidden = !visible.length;
      if (!visible.length && records.length && records.every(record => record.status === 'failed')) {
        title.textContent = '馆藏影像暂不可用，可继续浏览下方目录';
      }
      render(); sync();
    }
    function load(record) {
      if (suspended || record.status !== 'idle') return;
      record.status = 'loading';
      const batch = generation, ticket = ++record.request;
      const image = document.createElement('img');
      record.image = image;
      image.className = 'museum-backdrop-image';
      image.alt = '';
      image.width = record.source.cover.width;
      image.height = record.source.cover.height;
      image.decoding = 'async';
      const finish = success => {
        if (batch !== generation || ticket !== record.request || record.status !== 'loading') return;
        ++record.request; window.clearTimeout(record.timer);
        record.status = success ? 'ready' : 'failed';
        if (success) record.card.classList.add('is-ready');
        else record.card.remove();
        arrange();
      };
      image.addEventListener('load', () => finish(true), { once: true });
      image.addEventListener('error', () => finish(false), { once: true });
      record.card.append(image);
      record.timer = window.setTimeout(() => finish(false), 12000);
      image.src = record.source.cover.url;
    }
    function step(direction) {
      if (visible.length < 2) return;
      userPaused = true;
      const target = modulo((manual ? manual.target : frontIndex()) + direction, visible.length);
      const spacing = 360 / visible.length;
      let destination = -target * spacing;
      destination += Math.round((angle - destination) / 360) * 360;
      if (direction > 0 && destination > angle) destination -= 360;
      if (direction < 0 && destination < angle) destination += 360;
      if (canAnimate()) manual = { from: angle, to: destination, target, elapsed: 0 };
      else { angle = destination; manual = null; }
      render(); sync();
    }
    function clear() {
      ++generation; stopFrame();
      for (const record of records) window.clearTimeout(record.timer);
      records = []; visible = []; angle = 0; activeId = null; manual = null;
      stage.replaceChildren();
      stage.dataset.playing = stage.dataset.moving = 'false';
      stage.dataset.rotation = '0';
      controls.hidden = link.hidden = true;
      position.textContent = '';
      title.textContent = '新疆传统服饰 · 馆藏影像';
    }
    function setSources(values) {
      clear();
      const seen = new Set();
      const sources = values.filter(source => allowed.has(source.id) && !seen.has(source.id)
        && source.cover && typeof source.title === 'string'
        && /^[/]img[/]library[/][a-z0-9-]+[.]jpg$/.test(source.cover.url)
        && seen.add(source.id)).sort((a, b) => a.id - b.id);
      records = sources.map(source => {
        const card = document.createElement('div');
        card.className = 'museum-orbit-card';
        card.dataset.sourceId = String(source.id);
        stage.append(card);
        return { source, card, status: 'idle', image: null, request: 0, timer: null };
      });
      records.forEach(load);
    }
    toggle.addEventListener('click', () => {
      userPaused = !userPaused; manual = null;
      if (!userPaused) focused = false;
      sync();
    });
    previous.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    controls.addEventListener('focusin', () => { focused = true; sync(); });
    controls.addEventListener('focusout', event => {
      if (!controls.contains(event.relatedTarget) && event.relatedTarget !== link) { focused = false; sync(); }
    });
    link.addEventListener('focus', () => { detailFocused = focused = true; sync(); });
    link.addEventListener('blur', event => {
      detailFocused = false;
      if (!controls.contains(event.relatedTarget)) { focused = false; sync(); }
      else sync();
    });
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', () => {
      suspended = true; stopFrame();
      records.forEach(record => {
        if (record.status !== 'loading') return;
        ++record.request; window.clearTimeout(record.timer);
        record.image.remove(); record.image = null; record.status = 'idle';
      });
      sync();
    });
    window.addEventListener('pageshow', () => {
      if (!suspended) return;
      suspended = false; records.forEach(load); sync();
    });
    motion.addEventListener?.('change', () => {
      if (motion.matches && visible.length) {
        angle = -(manual ? manual.target : frontIndex()) * 360 / visible.length;
        manual = null; render();
      }
      sync();
    });
    if (typeof window.IntersectionObserver === 'function') {
      const observer = new window.IntersectionObserver(entries => {
        inView = entries.some(entry => entry.isIntersecting); sync();
      }, { threshold: 0.15 });
      observer.observe(hero);
    }
    return { setSources, clear };
  }
})();

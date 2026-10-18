/* Local-only synthetic fixtures. Executes the actual feedback script and form markup. */
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const KEY = 'cmit:trial-feedback:v1';
const directory = path.resolve(__dirname, '..', 'frontend');

function browser(initial = {}) {
  const html = fs.readFileSync(path.join(directory, 'guide.html'), 'utf8');
  const ids = new Map();
  const downloads = [];
  const blobs = new Map();
  const events = new Map();
  const entries = new Map(Object.entries(initial));
  const state = { readFails: false, writeFails: false, removeFails: false, confirmed: true, confirmations: [], writes: 0 };
  class Element {
    constructor(tag) { this.tagName = tag; this.value = ''; this.dataset = {}; this.events = {}; this.hidden = false; this.disabled = false; }
    addEventListener(type, fn) { this.events[type] = fn; }
    focus() { this.focused = true; }
    click() {
      if (this.disabled) return;
      if (this.tagName === 'a') downloads.push({ name: this.download, blob: blobs.get(this.href) });
      this.events.click?.({});
    }
    remove() {}
  }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]);
    element.id = match[2];
    element.hidden = /\bhidden\b/.test(match[0]);
    element.disabled = /\bdisabled\b/.test(match[0]);
    if (element.tagName === 'select') {
      const contents = html.slice(match.index + match[0].length).split('</select>')[0];
      const options = [...contents.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>/g)];
      element.value = (options.find((option) => /\bselected\b/.test(option[0])) || options[0])?.[1] ?? '';
    }
    ids.set(element.id, element);
  }
  const storage = {
    getItem(key) { if (state.readFails) throw new Error('denied'); return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { if (state.writeFails) throw new Error('quota'); state.writes++; entries.set(key, String(value)); },
    removeItem(key) { if (state.removeFails) throw new Error('denied'); entries.delete(key); },
  };
  const window = {
    localStorage: storage,
    addEventListener(type, fn) { events.set(type, fn); },
    confirm(message) { state.confirmations.push(message); state.duringConfirm?.(); return state.confirmed; },
    setTimeout(fn) { fn(); },
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-10-17T12:00:00.000Z'])); }
  }
  const document = { getElementById: (id) => ids.get(id), createElement: (tag) => new Element(tag), body: { append() {} } };
  const URL = { createObjectURL(blob) { const url = `blob:test-${blobs.size}`; blobs.set(url, blob); return url; }, revokeObjectURL() {} };
  const context = vm.createContext({ window, document, URL, Blob, Date: FixedDate,
    fetch() { throw new Error('Feedback must never make a network request'); } });
  const page = {
    get: (id) => ids.get(id), entries, state, downloads,
    start() { vm.runInContext(fs.readFileSync(path.join(directory, 'guide-feedback.js'), 'utf8'), context); return page; },
    edit(id, value) { ids.get(id).value = value; ids.get('trial-feedback-form').events.input({}); },
    fill() { page.edit('trial-role', 'visitor'); page.edit('trial-date', '2026-10-16'); page.edit('trial-step-1', 'independent'); },
    submit() { let prevented = false; ids.get('trial-feedback-form').events.submit({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); },
    leave() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; events.get('beforeunload')(event); return event.prevented; },
    changed(key, raw) { if (key !== null) { if (raw === null) entries.delete(key); else entries.set(key, raw); } else entries.clear(); events.get('storage')({ key, newValue: raw }); },
    click(id) { ids.get(id).click(); },
    get status() { return ids.get('trial-feedback-status').textContent; },
  };
  return page;
}

function savedRecord() {
  const page = browser().start(); page.fill(); page.submit(); return page.entries.get(KEY);
}

test('blank form has no implied trial, prefilled date, saved result or network request', () => {
  const page = browser().start();
  assert.equal(page.get('trial-date').value, '');
  assert.equal(page.get('trial-role').value, '');
  assert.equal(page.get('trial-task').value, '');
  for (let index = 1; index <= 6; index++) assert.equal(page.get(`trial-step-${index}`).value, 'not-tried');
  assert.match(page.status, /尚未填写/);
  assert.equal(page.leave(), false);
  page.submit(); page.click('trial-export-json');
  assert.equal(page.entries.size, 0); assert.equal(page.downloads.length, 0);
  assert.equal(page.get('trial-role').focused, true);
});

test('save records only an actual attempted step; optional alias and task need no personal information', () => {
  const page = browser().start(); page.fill();
  assert.equal(page.leave(), true);
  page.submit();
  const value = JSON.parse(page.entries.get(KEY));
  assert.equal(value.provenance, 'manual_trial_feedback');
  assert.equal(value.submitted, false); assert.equal(value.server_saved, false);
  assert.equal(value.storage_scope, 'current_browser_only');
  assert.equal(value.feedback.alias, ''); assert.equal(value.feedback.task, '');
  assert.equal(value.feedback.steps.filter((result) => result === 'not-tried').length, 5);
  assert.match(page.status, /已保存本机/); assert.equal(page.leave(), false);
  page.edit('trial-friction', '按钮不易找到');
  assert.match(page.status, /未保存/); assert.equal(page.leave(), true);
  page.submit(); assert.equal(page.leave(), false);
});

test('refresh offers explicit restoration without autofilling or silently replacing current typing', () => {
  const raw = savedRecord();
  const page = browser({ [KEY]: raw }).start();
  assert.equal(page.get('trial-role').value, '');
  assert.equal(page.get('trial-restore').hidden, false);
  assert.equal(page.get('trial-save').disabled, true);
  assert.equal(page.leave(), false);
  page.edit('trial-friction', '本次独立输入');
  page.state.confirmed = false; page.click('trial-restore');
  assert.equal(page.get('trial-friction').value, '本次独立输入');
  assert.equal(page.state.confirmations.length, 1);
  page.state.confirmed = true; page.click('trial-restore');
  assert.equal(page.get('trial-role').value, 'visitor');
  assert.equal(page.get('trial-friction').value, '');
  assert.equal(page.get('trial-restore').hidden, true);
  assert.equal(page.leave(), false);
  assert.equal(page.entries.get(KEY), raw);
});

test('all untried, nonexistent/future dates and invalid roles cannot become trial feedback', () => {
  const page = browser().start(); page.fill();
  const invalids = [['trial-step-1', 'not-tried'], ['trial-date', '2026-02-30'], ['trial-date', '2026-10-18'], ['trial-role', 'administrator']];
  for (const [id, value] of invalids) {
    page.fill(); page.edit(id, value); page.submit(); page.click('trial-export-txt');
    assert.equal(page.entries.size, 0); assert.equal(page.downloads.length, 0);
  }
});

test('text size limits also protect programmatic and restored input', () => {
  const page = browser().start(); page.fill();
  page.edit('trial-suggestion', '字'.repeat(4001)); page.submit();
  assert.equal(page.entries.size, 0); assert.match(page.status, /4000/);
  page.edit('trial-suggestion', ''); page.edit('trial-alias', 'x'.repeat(61)); page.submit();
  assert.equal(page.entries.size, 0); assert.match(page.status, /60/);
});

test('quota failures retain input and allow accurate TXT and JSON export without clearing leave protection', async () => {
  const page = browser().start(); page.fill();
  page.edit('trial-alias', '体验甲'); page.edit('trial-friction', '<img src=x>\n看不清按钮');
  page.state.writeFails = true; page.submit();
  assert.match(page.status, /保存失败/); assert.equal(page.leave(), true);
  page.click('trial-export-json'); page.click('trial-export-txt');
  assert.equal(page.downloads.length, 2);
  const value = JSON.parse(await page.downloads[0].blob.text());
  assert.equal(value.locally_saved, false); assert.equal(value.saved_at, null);
  assert.equal(value.submitted, false); assert.equal(value.server_saved, false);
  assert.equal(value.feedback.friction, '<img src=x>\n看不清按钮');
  const text = await page.downloads[1].blob.text();
  assert.match(text, /未提交服务器/); assert.match(text, /体验甲/); assert.match(text, /未尝试/);
  assert.equal(page.leave(), true); assert.equal(page.entries.size, 0);
});

test('saved export identifies local save without claiming submission', async () => {
  const page = browser().start(); page.fill(); page.submit(); page.click('trial-export-json');
  const data = JSON.parse(await page.downloads[0].blob.text());
  assert.equal(data.locally_saved, true); assert.ok(data.saved_at);
  assert.equal(data.server_saved, false); assert.equal(page.leave(), false);
});

test('export rechecks persistence rather than asserting an undelivered cross-tab update is saved', async () => {
  const page = browser().start(); page.fill(); page.submit();
  page.entries.delete(KEY); page.click('trial-export-json');
  const data = JSON.parse(await page.downloads[0].blob.text());
  assert.equal(data.locally_saved, false); assert.equal(data.saved_at, null);
  assert.match(page.status, /其他页面发生变化/);
});

test('bad storage is preserved and cannot be overwritten until an explicit scoped clear', () => {
  for (const raw of ['{', JSON.stringify({ schema_version: 2 }), 'x'.repeat(25000)]) {
    const page = browser({ [KEY]: raw, 'cmit:workspace-draft:v1:new': 'keep' }).start(); page.fill();
    assert.match(page.status, /无法读取/); page.submit(); assert.equal(page.entries.get(KEY), raw);
    page.state.confirmed = false; page.click('trial-clear'); assert.equal(page.entries.get(KEY), raw);
    page.state.confirmed = true; page.click('trial-clear'); assert.equal(page.entries.has(KEY), false);
    assert.equal(page.entries.get('cmit:workspace-draft:v1:new'), 'keep');
    assert.equal(page.get('trial-role').value, 'visitor');
    page.submit(); assert.equal(JSON.parse(page.entries.get(KEY)).feedback.role, 'visitor');
  }
});

test('stored records claiming server submission or impossible trials are rejected', () => {
  for (const modify of [value => { value.submitted = true; }, value => { value.feedback.steps.fill('not-tried'); },
    value => { value.feedback.date = '2026-02-30'; }, value => { value.feedback.role = ['visitor']; },
    value => { value.feedback.steps[0] = ['independent']; }]) {
    const value = JSON.parse(savedRecord()); modify(value);
    const raw = JSON.stringify(value); const page = browser({ [KEY]: raw }).start();
    assert.match(page.status, /无法读取/); assert.equal(page.get('trial-restore').hidden, true);
    assert.equal(page.entries.get(KEY), raw);
  }
});

test('storage access failures do not block export and cannot later overwrite an unseen record', async () => {
  const page = browser({ [KEY]: savedRecord() }); page.state.readFails = true; page.start(); page.fill(); page.submit();
  assert.match(page.status, /存储暂不可用/); page.click('trial-export-json');
  assert.equal(JSON.parse(await page.downloads[0].blob.text()).locally_saved, false);
  page.state.readFails = false; page.submit();
  assert.match(page.status, /其他页面发生变化/); assert.equal(page.state.writes, 0);
});

test('cross-tab changes block overwrite and deletion while keeping current content exportable', async () => {
  const raw = savedRecord(); const page = browser().start(); page.fill();
  page.changed('unrelated', 'anything'); assert.equal(page.get('trial-save').disabled, false);
  page.changed(KEY, raw);
  assert.match(page.status, /其他页面发生变化/); assert.equal(page.get('trial-save').disabled, true);
  page.submit(); page.click('trial-clear'); assert.equal(page.entries.get(KEY), raw);
  page.click('trial-export-json');
  assert.equal(JSON.parse(await page.downloads[0].blob.text()).locally_saved, false);
  assert.equal(page.leave(), true);
});

test('save checks storage even when no storage event was delivered', () => {
  const page = browser().start(); page.fill(); const other = savedRecord();
  page.entries.set(KEY, other); page.submit();
  assert.equal(page.entries.get(KEY), other); assert.equal(page.state.writes, 0);
  assert.match(page.status, /其他页面发生变化/);
});

test('changes during restore/clear confirmation are rechecked and never erased', () => {
  for (const action of ['trial-restore', 'trial-clear']) {
    const raw = savedRecord(); const page = browser({ [KEY]: raw }).start(); page.fill();
    const other = JSON.stringify({ ...JSON.parse(raw), saved_at: '2026-10-17T12:01:00.000Z' });
    page.state.duringConfirm = () => page.entries.set(KEY, other);
    page.click(action);
    assert.match(page.status, /其他页面发生变化/); assert.equal(page.entries.get(KEY), other);
    assert.equal(page.get('trial-role').value, 'visitor');
  }
});

test('clear keeps page input, protects unsaved changes and removes only this feedback key', () => {
  const page = browser({ other: 'keep' }).start(); page.fill(); page.submit(); page.click('trial-clear');
  assert.equal(page.entries.has(KEY), false); assert.equal(page.entries.get('other'), 'keep');
  assert.equal(page.get('trial-date').value, '2026-10-16'); assert.equal(page.leave(), true);
  assert.match(page.status, /已清除本机反馈/);
});

test('failed deletion is not reported as successful and same-value storage events are harmless', () => {
  const page = browser().start(); page.fill(); page.submit(); const raw = page.entries.get(KEY);
  page.changed(KEY, raw); assert.equal(page.get('trial-save').disabled, false);
  page.state.removeFails = true; page.click('trial-clear');
  assert.match(page.status, /清除失败/); assert.equal(page.entries.get(KEY), raw);
  page.state.removeFails = false; page.changed(null, null);
  assert.match(page.status, /其他页面发生变化/);
});

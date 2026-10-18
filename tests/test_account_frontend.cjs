/* Shared account/session behavior against a small observable browser harness.
 * Run: node tests/test_account_frontend.cjs
 * Cookies are server-managed: any attempt to read/write document.cookie fails.
 * Login form behavior and browser layout have separate tests.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const code = fs.readFileSync(path.join(__dirname, '../frontend/account.js'), 'utf8');
const USER_A = 'a'.repeat(32);
const USER_B = 'b'.repeat(32);
const CSRF_A = 'csrf-a'.repeat(7);
const CSRF_REFRESHED = 'csrf-refreshed'.repeat(3);
const response = (value, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => structuredClone(value),
});
const account = (id = USER_A, csrf = CSRF_A) => ({ user: { id, username: '测试账号' }, csrf_token: csrf });
const deferred = () => {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
};
const settle = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

function page({ id = USER_A, address = '/index.html?source=7#review',
  data = new Map(), sessionResponse = response(account(id)), username = '测试账号' } = {}) {
  class Element {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.events = new Map();
      this.attributes = {}; this.className = ''; this.textContent = '';
      this.hidden = false; this.disabled = false; this.open = false;
    }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, callback) { this.events.set(type, callback); }
    querySelector(selector) {
      const matches = node => selector.startsWith('.')
        ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tagName === selector;
      for (const child of this.children) {
        if (matches(child)) return child;
        const descendant = child.querySelector(selector);
        if (descendant) return descendant;
      }
      return null;
    }
    showModal() { this.open = true; }
    close() { this.open = false; }
    click() { return this.disabled ? undefined : this.events.get('click')?.({}); }
  }
  const body = new Element('body');
  const controls = new Element('nav');
  const document = {
    documentElement: { dataset: id ? { accountId: id, accountName: username } : {} },
    body, createElement: tag => new Element(tag),
    querySelector: selector => selector === '.account-controls' ? controls : body.querySelector(selector),
  };
  Object.defineProperty(document, 'cookie', {
    get() { assert.fail('Account script must not read the HttpOnly session cookie'); },
    set() { assert.fail('Account script must not write the session cookie'); },
  });
  const storageWrites = [];
  const localStorage = {
    getItem: key => data.get(String(key)) ?? null,
    setItem(key, value) { storageWrites.push([String(key), String(value)]); data.set(String(key), String(value)); },
    removeItem: key => data.delete(String(key)),
  };
  const sessionStorage = {
    setItem() { assert.fail('Account credentials must not be put in sessionStorage'); },
    getItem() { assert.fail('Account identity must not be trusted from sessionStorage'); },
  };
  const url = new URL(address, 'https://example.test');
  const assigned = [];
  const location = Object.fromEntries(['href', 'origin', 'pathname', 'search', 'hash'].map(key => [key, url[key]]));
  location.assign = value => assigned.push(value);
  const events = new Map();
  const requests = [];
  const routes = new Map();
  let nextSession = sessionResponse;
  let flushes = 0;
  let exports = 0;
  let saved = true;
  let confirmation = true;
  let confirmations = 0;
  const nativeFetch = async (input, options = {}) => {
    const route = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    requests.push({ input, route, options });
    const value = route === '/api/auth/session' ? nextSession : routes.get(route) || response({ ok: true });
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(input, options) : value;
  };
  const window = {
    fetch: nativeFetch, location, localStorage, sessionStorage,
    addEventListener: (type, callback) => events.set(type, callback),
    flushDraftSave() { flushes++; },
    exportLocalDraft() { exports++; },
    isLocalDraftSaved: () => saved,
    confirm() { confirmations++; return confirmation; },
  };
  const context = vm.createContext({ document, window, location, localStorage, sessionStorage,
    URL, Headers, Request, AbortSignal, console });
  vm.runInContext(code, context, { filename: 'account.js' });
  return {
    window, document, controls, requests, data, storageWrites, assigned,
    get account() { return window.Account; },
    get panel() { return body.querySelector('dialog'); },
    get logout() { return controls.querySelector('button'); },
    get flushes() { return flushes; }, get exports() { return exports; },
    get confirmations() { return confirmations; },
    setSession(value) { nextSession = value; },
    respond(route, value) { routes.set(route, value); },
    dispatch(type, event = {}) { return events.get(type)?.(event); },
    draftSaved(value) { saved = value; },
    confirm(value) { confirmation = value; },
  };
}

test('private requests wait for server session, preserve headers, and send only appropriate CSRF headers', async () => {
  const pending = deferred();
  const site = page({ sessionResponse: pending.promise });
  const reading = site.account.fetch('/api/reviews', { headers: { Accept: 'application/json' } });
  await settle();
  assert.deepEqual(site.requests.map(item => item.route), ['/api/auth/session']);
  assert.equal(site.requests[0].options.credentials, 'same-origin');
  assert.equal(site.requests[0].options.cache, 'no-store');
  assert.equal(site.storageWrites.length, 0);
  pending.resolve(response(account()));
  await reading;
  const read = site.requests.at(-1);
  assert.equal(read.options.headers.get('X-Account-ID'), USER_A);
  assert.equal(read.options.headers.get('X-CSRF-Token'), null);
  assert.equal(read.options.headers.get('Accept'), 'application/json');
  assert.equal(read.options.credentials, 'same-origin');
  await site.account.fetch('/api/review', {
    method: 'post', body: 'body', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
  });
  const write = site.requests.at(-1);
  assert.equal(write.options.headers.get('X-CSRF-Token'), CSRF_A);
  assert.equal(write.options.headers.get('X-Account-ID'), USER_A);
  assert.equal(write.options.headers.get('Content-Type'), 'application/json');
  assert.equal(write.options.credentials, 'same-origin');
  assert.equal(write.options.body, 'body');
  assert.equal(site.storageWrites.length, 0, 'Session and CSRF tokens stay in memory');
  assert.equal(Object.isFrozen(site.account), true);
});

test('Request inputs preserve their method and custom headers; external and public requests stay public', async () => {
  const site = page();
  await site.account.ready;
  const request = new Request('https://example.test/api/review', {
    method: 'POST', headers: { 'X-Fixture': 'preserved' }, body: '{}',
  });
  await site.account.fetch(request);
  assert.equal(site.requests.at(-1).input, request);
  assert.equal(site.requests.at(-1).options.headers.get('X-Fixture'), 'preserved');
  assert.equal(site.requests.at(-1).options.headers.get('X-CSRF-Token'), CSRF_A);
  for (const route of ['/api/sources', '/api/library', '/api/library/1', '/guide.html', 'https://other.test/api/review']) {
    const options = { headers: { Accept: 'application/json' } };
    await site.account.fetch(route, options);
    assert.equal(site.requests.at(-1).options, options, route);
    assert.equal(site.requests.at(-1).options.headers['X-CSRF-Token'], undefined);
    assert.equal(site.requests.at(-1).options.headers['X-Account-ID'], undefined);
  }
});

test('draft storage stays under the server account, survives refresh, and never claims legacy drafts', async () => {
  const legacyKey = 'cmit:workspace-draft:v1:new';
  const data = new Map([[legacyKey, 'legacy unowned draft'], ['user_id', USER_B]]);
  const first = page({ data });
  await first.account.ready;
  assert.equal(first.account.id, USER_A, 'Local data cannot replace the server identity');
  assert.equal(first.account.storage().getItem(legacyKey), null);
  first.account.storage().setItem(legacyKey, 'A draft');
  assert.equal(data.get(first.account.storageKey(legacyKey)), 'A draft');
  const refreshed = page({ data });
  await refreshed.account.ready;
  assert.equal(refreshed.account.storage().getItem(legacyKey), 'A draft');
  const second = page({ id: USER_B, data });
  await second.account.ready;
  assert.equal(second.account.storage().getItem(legacyKey), null);
  second.account.storage().setItem(legacyKey, 'B draft');
  second.account.storage().removeItem(legacyKey);
  assert.equal(first.account.storage().getItem(legacyKey), 'A draft');
  assert.equal(data.get(legacyKey), 'legacy unowned draft');
  assert.notEqual(first.account.storageKey(legacyKey), second.account.storageKey(legacyKey));
});

test('expired initial session blocks private fetch and exposes a non-dismissible recovery dialog', async () => {
  const site = page({ sessionResponse: response({ error: 'expired' }, 401) });
  assert.equal(await site.account.ready, null);
  assert.equal(site.panel.open, true);
  assert.match(site.panel.querySelector('.account-session-detail').textContent, /过期|退出/);
  let prevented = false;
  site.panel.events.get('cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(site.panel.querySelector('a').href, '/login.html?next=%2Findex.html%3Fsource%3D7%23review');
  assert.ok(site.flushes > 0);
  const backup = site.panel.querySelector('.text-button');
  assert.equal(backup.hidden, false);
  backup.click();
  assert.equal(site.exports, 1);
  await assert.rejects(site.account.fetch('/api/reviews'), /重新登录/);
  assert.deepEqual(site.requests.map(item => item.route), ['/api/auth/session']);
});

test('cross-tab account switch blocks immediately, preserves original draft scope, and recovers original account', async () => {
  const site = page();
  await site.account.ready;
  site.account.storage().setItem('draft', 'original draft');
  const pending = deferred();
  site.setSession(pending.promise);
  site.dispatch('storage', { key: 'cmit:auth-change' });
  assert.equal(site.panel.open, true);
  await assert.rejects(site.account.fetch('/api/review', { method: 'POST' }), /重新登录/);
  pending.resolve(response(account(USER_B)));
  await settle();
  assert.match(site.panel.querySelector('.account-session-detail').textContent, /切换账号/);
  assert.equal(site.account.id, USER_A);
  assert.equal(site.account.storage().getItem('draft'), 'original draft');
  await assert.rejects(site.account.fetch('/api/reviews'), /重新登录/);
  assert.equal(site.requests.some(item => item.route === '/api/review'), false);
  site.setSession(response(account(USER_A, CSRF_REFRESHED)));
  await site.panel.querySelector('.secondary-button').click();
  assert.equal(site.panel.open, false);
  await site.account.fetch('/api/review', { method: 'POST' });
  assert.equal(site.requests.at(-1).options.headers.get('X-CSRF-Token'), CSRF_REFRESHED);
});

test('401 or 403 from private API blocks subsequent requests and preserves draft for reconnect', async () => {
  for (const status of [401, 403]) {
    const site = page();
    await site.account.ready;
    site.respond('/api/review', response({ error: 'session changed' }, status));
    await assert.rejects(site.account.fetch('/api/review', { method: 'POST' }), /登录状态已变化/);
    assert.equal(site.panel.open, true);
    const count = site.requests.length;
    await assert.rejects(site.account.fetch('/api/reviews'), /重新登录/);
    assert.equal(site.requests.length, count);
    assert.ok(site.flushes > 0);
  }
});

test('offline and malformed session responses fail closed without storing tokens', async () => {
  for (const value of [new Error('offline'), response({}, 503), response({ user: { id: 'wrong' }, csrf_token: 'token' }), response({ user: { id: USER_A } })]) {
    const site = page({ sessionResponse: value });
    assert.equal(await site.account.ready, null);
    assert.equal(site.panel.open, true);
    await assert.rejects(site.account.fetch('/api/reviews'), /重新登录/);
    assert.equal(site.requests.length, 1);
    assert.equal(site.storageWrites.length, 0);
  }
});

test('focus refresh rotates CSRF, while restored pages and cleared storage revalidate before private work', async () => {
  const site = page();
  await site.account.ready;
  site.setSession(response(account(USER_A, CSRF_REFRESHED)));
  site.dispatch('focus');
  await settle();
  await site.account.fetch('/api/review', { method: 'POST' });
  assert.equal(site.requests.at(-1).options.headers.get('X-CSRF-Token'), CSRF_REFRESHED);
  const count = site.requests.length;
  site.dispatch('pageshow', { persisted: false });
  site.dispatch('storage', { key: 'unrelated' });
  await settle();
  assert.equal(site.requests.length, count);
  for (const [type, event] of [['pageshow', { persisted: true }], ['storage', { key: null }]]) {
    const pending = deferred();
    site.setSession(pending.promise);
    site.dispatch(type, event);
    assert.equal(site.panel.open, true);
    await assert.rejects(site.account.fetch('/api/reviews'), /重新登录/);
    pending.resolve(response(account()));
    await settle();
    assert.equal(site.panel.open, false);
  }
});

test('logout flushes drafts, honors unsaved cancellation, sends CSRF once and notifies other tabs', async () => {
  const site = page();
  await site.account.ready;
  site.account.storage().setItem('draft', 'saved draft');
  site.draftSaved(false);
  site.confirm(false);
  await site.logout.click();
  assert.equal(site.confirmations, 1);
  assert.ok(site.flushes > 0);
  assert.equal(site.requests.some(item => item.route === '/api/auth/logout'), false);
  assert.deepEqual(site.assigned, []);
  site.draftSaved(true);
  const pending = deferred();
  site.respond('/api/auth/logout', pending.promise);
  const logout = site.logout.click();
  await settle();
  assert.equal(site.logout.disabled, true);
  site.logout.click();
  assert.equal(site.requests.filter(item => item.route === '/api/auth/logout').length, 1);
  const request = site.requests.at(-1);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.get('X-CSRF-Token'), CSRF_A);
  assert.equal(request.options.headers.get('X-Account-ID'), USER_A);
  pending.resolve(response({ ok: true }));
  await logout;
  assert.deepEqual(site.assigned, ['/login.html']);
  assert.equal(JSON.parse(site.data.get('cmit:auth-change')).user_id, null);
  assert.equal(site.account.storage().getItem('draft'), 'saved draft');
  assert.equal(site.logout.disabled, false);
  await assert.rejects(site.account.fetch('/api/reviews'), /重新登录/);
  assert.equal(site.storageWrites.some(([, value]) => value.includes(CSRF_A)), false);
});

test('failed logout stays on the page with a recoverable session warning', async () => {
  const site = page();
  await site.account.ready;
  site.respond('/api/auth/logout', response({ error: 'offline' }, 503));
  await site.logout.click();
  assert.deepEqual(site.assigned, []);
  assert.equal(site.logout.disabled, false);
  assert.equal(site.logout.textContent, '重试退出');
  assert.equal(site.panel.open, true);
  assert.equal(site.data.has('cmit:auth-change'), false);
});

test('guest public pages stay available without a modal or account credentials', async () => {
  const site = page({ id: null, address: '/library.html', sessionResponse: response({}, 401) });
  assert.equal(await site.account.ready, null);
  assert.equal(site.panel, null);
  assert.equal(site.account.id, null);
  assert.equal(site.controls.querySelector('a').textContent, '登录 / 注册');
  await site.account.fetch('/api/library');
  assert.equal(site.requests.at(-1).options.headers, undefined);
  await assert.rejects(site.account.fetch('/api/reviews'), /重新登录/);
  assert.equal(site.requests.some(item => item.route === '/api/reviews'), false);
  assert.equal(site.panel, null);
});

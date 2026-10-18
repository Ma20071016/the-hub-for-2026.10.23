/* Run: node tests/test_login_frontend.cjs. Executes the real form controller. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/login.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'frontend/login.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { await flush(); await flush(); };

function page({ address = 'http://localhost/login.html', session = { status: 401 }, post = { status: 200, data: { user: { id: 'u1', username: 'reader' }, csrf_token: 'csrf' } }, storageError = false } = {}) {
  const ids = new Map();
  class Element {
    constructor(id, attributes) {
      this.id = id; this.value = ''; this.textContent = ''; this.events = {}; this.dataset = {};
      this.attributes = {}; this.hidden = /\bhidden\b/.test(attributes); this.disabled = /\bdisabled\b/.test(attributes);
      this.type = attributes.match(/\btype="([^"]+)"/)?.[1] || '';
    }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, callback) { this.events[type] = callback; }
    focus() { this.focused = true; }
    click() { if (!this.disabled) this.events.click?.({}); }
  }
  for (const match of html.matchAll(/<\w+[^>]*\bid="([^"]+)"[^>]*>/g)) ids.set(match[1], new Element(match[1], match[0]));
  const calls = []; const storage = []; const navigation = []; const timers = new Map(); let nextTimer = 0;
  const url = new URL(address);
  const window = {
    location: { href: url.href, origin: url.origin, search: url.search, hash: url.hash, replace(value) { navigation.push(value); } },
    localStorage: { setItem(key, value) { if (storageError) throw new Error('disabled'); storage.push({ key, value }); } },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  };
  const response = value => ({ ok: value.status >= 200 && value.status < 300, status: value.status, json: async () => value.data || {} });
  const fetch = async (endpoint, options) => {
    calls.push({ endpoint, options });
    const result = endpoint === '/api/auth/session' ? session : post;
    if (typeof result === 'function') return result(endpoint, options);
    if (result.error) throw result.error;
    return response(result);
  };
  const document = { title: '', getElementById: id => ids.get(id) };
  vm.runInNewContext(source, { document, window, fetch, URL, URLSearchParams, AbortController, Error, TypeError });
  const submit = () => ids.get('auth-form').events.submit({ preventDefault() {} });
  const credentials = (username = 'reader', password = 'secure password') => { ids.get('auth-username').value = username; ids.get('auth-password').value = password; };
  return { ids, calls, storage, navigation, document, timers, submit, credentials };
}

(async () => {
  const initial = page(); await settle();
  assert.equal(initial.ids.get('auth-confirm').disabled, true);
  assert.equal(initial.ids.get('auth-password').autocomplete, 'current-password');
  assert.equal(initial.calls[0].options.credentials, 'same-origin');
  await initial.submit();
  assert.equal(initial.calls.length, 1, 'empty form must not reach server');
  assert.equal(initial.ids.get('auth-username').getAttribute('aria-invalid'), 'true');
  initial.credentials('reader', 'short'); await initial.submit();
  assert.match(initial.ids.get('auth-feedback').textContent, /8 至 128/);
  assert.equal(initial.calls.length, 1);

  initial.ids.get('register-tab').click();
  assert.equal(initial.ids.get('confirm-field').hidden, false);
  assert.equal(initial.ids.get('auth-confirm').disabled, false);
  assert.equal(initial.ids.get('auth-password').autocomplete, 'new-password');
  assert.equal(initial.ids.get('auth-panel').getAttribute('aria-labelledby'), 'register-tab');
  initial.credentials(); initial.ids.get('auth-confirm').value = 'different password'; await initial.submit();
  assert.match(initial.ids.get('auth-feedback').textContent, /不一致/);
  assert.equal(initial.calls.length, 1, 'mismatched passwords must not reach server');
  initial.ids.get('auth-confirm').value = 'secure password';
  initial.ids.get('password-toggle').click();
  assert.equal(initial.ids.get('auth-password').type, 'text');
  assert.equal(initial.ids.get('auth-confirm').type, 'text');
  assert.equal(initial.ids.get('password-toggle').getAttribute('aria-pressed'), 'true');
  await initial.submit();
  assert.equal(initial.calls[1].endpoint, '/api/auth/register');
  assert.deepEqual(JSON.parse(initial.calls[1].options.body), { username: 'reader', password: 'secure password' });
  assert.deepEqual(initial.navigation, ['/index.html']);
  assert.equal(initial.ids.get('auth-password').value, '');
  assert.equal(initial.storage.length, 1);
  assert.equal(initial.storage[0].key, 'cmit:auth-change');
  assert.equal(JSON.parse(initial.storage[0].value).user_id, 'u1');
  assert.equal(initial.storage[0].value.includes('secure password'), false);

  const login = page({ address: 'http://localhost/login.html?next=%2Fsource.html%3Fid%3D4%23evidence', storageError: true });
  await settle(); login.credentials('  Ｒｅａｄｅｒ  ', '  spaced password  '); await login.submit();
  assert.equal(login.calls[1].endpoint, '/api/auth/login');
  assert.equal(JSON.parse(login.calls[1].options.body).username, 'Reader');
  assert.equal(JSON.parse(login.calls[1].options.body).password, '  spaced password  ', 'password whitespace must be preserved');
  assert.deepEqual(login.navigation, ['/source.html?id=4#evidence']);

  for (const next of ['https://evil.example/', '//evil.example/', '/login.html', '/api/reviews', 'javascript:alert(1)', 'http://name:pass@localhost/index.html']) {
    const unsafe = page({ address: 'http://localhost/login.html?next=' + encodeURIComponent(next) });
    await settle(); unsafe.credentials(); await unsafe.submit();
    assert.deepEqual(unsafe.navigation, ['/index.html'], `reject return URL ${next}`);
  }

  const registered = page({ address: 'http://localhost/login.html?mode=register', session: { status: 200, data: { user: { id: 'existing' } } } });
  await settle(); assert.deepEqual(registered.navigation, ['/index.html']);

  const rejected = page({ post: { status: 401, data: { error: '用户名或密码不正确。' } } });
  await settle(); rejected.credentials(); await rejected.submit();
  assert.match(rejected.ids.get('auth-feedback').textContent, /用户名或密码不正确/);
  assert.equal(rejected.ids.get('auth-submit').disabled, false);
  assert.equal(rejected.ids.get('auth-username').disabled, false);
  assert.equal(rejected.navigation.length, 0);

  const duplicate = page({ post: { status: 409, data: { error: '这个用户名已被使用，请换一个。' } } });
  await settle(); duplicate.ids.get('register-tab').click(); duplicate.credentials(); duplicate.ids.get('auth-confirm').value = 'secure password'; await duplicate.submit();
  assert.match(duplicate.ids.get('auth-feedback').textContent, /已被使用/);
  assert.equal(duplicate.ids.get('auth-confirm').disabled, false);

  const limited = page({ post: { status: 429 } }); await settle(); limited.credentials(); await limited.submit();
  assert.match(limited.ids.get('auth-feedback').textContent, /尝试次数/);
  const network = page({ post: { error: new TypeError('Failed to fetch') } }); await settle(); network.credentials(); await network.submit();
  assert.match(network.ids.get('auth-feedback').textContent, /检查网络/);
  const malformed = page({ post: { status: 200, data: {} } }); await settle(); malformed.credentials(); await malformed.submit();
  assert.equal(malformed.navigation.length, 0);
  assert.match(malformed.ids.get('auth-feedback').textContent, /登录状态暂未确认/);

  let complete;
  const pending = page({ post: () => new Promise(resolve => { complete = resolve; }) });
  await settle(); pending.credentials(); const first = pending.submit(); const second = pending.submit();
  assert.equal(pending.calls.length, 2, 'double submit must only send one POST');
  assert.equal(pending.ids.get('auth-submit').disabled, true);
  assert.equal(pending.ids.get('register-tab').disabled, true);
  complete({ ok: false, status: 503, json: async () => ({}) }); await Promise.all([first, second]);
  assert.equal(pending.ids.get('auth-submit').disabled, false);
  assert.equal(pending.ids.get('auth-confirm').disabled, true);

  const keyboard = page(); await settle();
  keyboard.ids.get('login-tab').events.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(keyboard.ids.get('register-tab').getAttribute('aria-selected'), 'true');
  assert.equal(keyboard.ids.get('register-tab').focused, true);
  keyboard.ids.get('register-tab').events.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(keyboard.ids.get('login-tab').getAttribute('aria-selected'), 'true');
  keyboard.ids.get('auth-password').events.keydown({ getModifierState: key => key === 'CapsLock' });
  assert.equal(keyboard.ids.get('caps-lock-hint').hidden, false);
  keyboard.ids.get('auth-password').events.blur();
  assert.equal(keyboard.ids.get('caps-lock-hint').hidden, true);

  console.log('Login/register frontend behavior, validation, API, storage, and redirect checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });

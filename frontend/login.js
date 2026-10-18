/* Cookie-based account entry; passwords and session tokens never enter storage. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const form = byId('auth-form');
  if (!form) return;
  const fields = { username: byId('auth-username'), password: byId('auth-password'), confirm: byId('auth-confirm') };
  const tabs = { login: byId('login-tab'), register: byId('register-tab') };
  const feedback = byId('auth-feedback');
  const submit = byId('auth-submit');
  const submitLabel = byId('auth-submit-label');
  const toggle = byId('password-toggle');
  const switchButton = byId('auth-switch');
  let mode = 'login';
  let busy = false;
  let attempted = false;

  function safeDestination(value) {
    try {
      const url = new URL(value || './index.html', window.location.href);
      const pages = ['/', '/index.html', '/archive.html', '/library.html', '/source.html', '/guide.html'];
      if (url.origin === window.location.origin && !url.username && !url.password && pages.includes(url.pathname)) {
        return url.pathname + url.search + url.hash;
      }
    } catch (_) { /* An invalid return URL uses the workbench. */ }
    return '/index.html';
  }
  const params = new URLSearchParams(window.location.search);
  const destination = safeDestination(params.get('next'));

  function setFeedback(message, state = 'error') {
    feedback.textContent = message;
    feedback.dataset.state = state;
    feedback.hidden = !message;
  }

  function setBusy(value) {
    busy = value;
    submit.disabled = value;
    submit.setAttribute('aria-busy', String(value));
    form.setAttribute('aria-busy', String(value));
    tabs.login.disabled = value;
    tabs.register.disabled = value;
    switchButton.disabled = value;
    fields.username.disabled = value;
    fields.password.disabled = value;
    fields.confirm.disabled = value || mode !== 'register';
    submitLabel.textContent = value ? (mode === 'register' ? '正在创建账号…' : '正在登录…') : (mode === 'register' ? '注册并进入' : '登录');
  }

  function setMode(next, focus = false) {
    if (busy) return;
    mode = next === 'register' ? 'register' : 'login';
    const registering = mode === 'register';
    for (const [name, tab] of Object.entries(tabs)) {
      tab.setAttribute('aria-selected', String(name === mode));
      tab.tabIndex = name === mode ? 0 : -1;
    }
    byId('auth-panel').setAttribute('aria-labelledby', `${mode}-tab`);
    byId('auth-title').textContent = registering ? '开启你的审阅空间' : '欢迎回来';
    byId('auth-description').textContent = registering ? '创建账号，从第一份有据可查的文稿开始。' : '登录账号，继续你的资料与文稿审阅。';
    byId('confirm-field').hidden = !registering;
    byId('username-hint').hidden = !registering;
    byId('password-hint').hidden = !registering;
    byId('caps-lock-hint').hidden = true;
    fields.confirm.disabled = !registering;
    fields.confirm.required = registering;
    fields.password.autocomplete = registering ? 'new-password' : 'current-password';
    fields.password.placeholder = registering ? '设置 8–128 位密码' : '请输入密码';
    fields.password.value = '';
    fields.confirm.value = '';
    fields.password.type = 'password';
    fields.confirm.type = 'password';
    toggle.textContent = '显示';
    toggle.setAttribute('aria-label', '显示密码');
    toggle.setAttribute('aria-pressed', 'false');
    byId('auth-switch-prompt').textContent = registering ? '已有账号？' : '还没有账号？';
    switchButton.textContent = registering ? '返回登录' : '立即注册';
    submitLabel.textContent = registering ? '注册并进入' : '登录';
    document.title = `${registering ? '注册' : '登录'} · 传统服饰说明核验`;
    for (const field of Object.values(fields)) field.removeAttribute('aria-invalid');
    setFeedback('');
    if (focus) fields.username.focus();
  }

  function invalid(field, message) {
    field.setAttribute('aria-invalid', 'true');
    setFeedback(message);
    field.focus();
    return false;
  }

  function validFields() {
    for (const field of Object.values(fields)) field.removeAttribute('aria-invalid');
    const username = fields.username.value.normalize('NFKC').trim();
    if (!username) return invalid(fields.username, '请输入用户名。');
    if (!/^[A-Za-z0-9_-㐀-䶿一-鿿]{3,24}$/.test(username)) {
      return invalid(fields.username, '用户名须为 3 至 24 个汉字、英文字母、数字、下划线或短横线。');
    }
    fields.username.value = username;
    const length = Array.from(fields.password.value).length;
    if (!length) return invalid(fields.password, '请输入密码。');
    if (length < 8 || length > 128) return invalid(fields.password, '密码须为 8 至 128 个字符。');
    if (mode === 'register' && fields.confirm.value !== fields.password.value) {
      return invalid(fields.confirm, '两次输入的密码不一致，请重新确认。');
    }
    return true;
  }

  function enterWorkspace(data) {
    if (!data || !data.user || typeof data.user.id !== 'string' || !data.user.id) throw new Error('登录状态暂未确认，请重试。');
    try {
      window.localStorage.setItem('cmit:auth-change', JSON.stringify({ user_id: data.user.id, at: Date.now() }));
    } catch (_) { /* Cookies still work when browser storage is unavailable. */ }
    fields.password.value = '';
    fields.confirm.value = '';
    window.location.replace(destination);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    attempted = true;
    if (!validFields()) return;
    const payload = { username: fields.username.value, password: fields.password.value };
    setFeedback('');
    setBusy(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    let success = false;
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = response.status === 429 ? '尝试次数较多，请稍后再试。' : response.status >= 500 ? '账号服务暂时不可用，请稍后重试。' : '未能完成登录，请检查输入后重试。';
        throw new Error(typeof data.error === 'string' && data.error ? data.error.slice(0, 240) : fallback);
      }
      setFeedback(mode === 'register' ? '账号已创建，正在进入审阅工作台…' : '登录成功，正在进入…', 'success');
      enterWorkspace(data);
      success = true;
    } catch (error) {
      const message = error.name === 'AbortError' ? '连接超时，请检查网络后重试。' : error instanceof TypeError ? '暂时无法连接账号服务，请检查网络后重试。' : error.message || '操作未完成，请稍后重试。';
      setFeedback(message);
    } finally {
      window.clearTimeout(timeout);
      if (!success) setBusy(false);
    }
  });

  for (const [name, tab] of Object.entries(tabs)) {
    tab.addEventListener('click', () => setMode(name));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' : mode === 'login' ? 'register' : 'login';
      setMode(next);
      tabs[next].focus();
    });
  }
  switchButton.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login', true));
  toggle.addEventListener('click', () => {
    const show = fields.password.type === 'password';
    fields.password.type = show ? 'text' : 'password';
    fields.confirm.type = show ? 'text' : 'password';
    toggle.textContent = show ? '隐藏' : '显示';
    toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    toggle.setAttribute('aria-pressed', String(show));
  });
  for (const field of Object.values(fields)) {
    field.addEventListener('input', () => field.removeAttribute('aria-invalid'));
  }
  for (const field of [fields.password, fields.confirm]) {
    const showCapsLock = event => { byId('caps-lock-hint').hidden = !event.getModifierState?.('CapsLock'); };
    field.addEventListener('keydown', showCapsLock);
    field.addEventListener('keyup', showCapsLock);
    field.addEventListener('blur', () => { byId('caps-lock-hint').hidden = true; });
  }

  setMode(params.get('mode') === 'register' || window.location.hash === '#register' ? 'register' : 'login');
  if (params.get('expired') === '1') setFeedback('登录已失效，请重新登录后继续。', 'info');
  const sessionController = new AbortController();
  const sessionTimeout = window.setTimeout(() => sessionController.abort(), 10000);
  fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: sessionController.signal })
    .then(async response => {
      if (!response.ok || attempted) return;
      const data = await response.json();
      if (!attempted) enterWorkspace(data);
    })
    .catch(() => { /* The login form remains available after a failed session check. */ })
    .finally(() => window.clearTimeout(sessionTimeout));
})();

/* Account identity is supplied by the server, never trusted from browser storage. */
(function () {
  'use strict';
  const root = document.documentElement;
  const id = root.dataset.accountId || null;
  const username = root.dataset.accountName || '';
  const privatePage = ['/', '/index.html', '/archive.html'].includes(location.pathname);
  const nativeFetch = window.fetch.bind(window);
  const prefix = id ? `cmit:account:${id}:` : 'cmit:guest:';
  let session = null;
  let blocked = false;
  let checking = null;
  let panel = null;
  let signingOut = false;

  function loginURL() {
    return '/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
  }

  function flushDraft() {
    if (typeof window.flushDraftSave === 'function') window.flushDraftSave();
  }

  function showSessionProblem(message) {
    blocked = true;
    session = null;
    flushDraft();
    if (!privatePage) return;
    if (!panel) {
      panel = document.createElement('dialog');
      panel.className = 'account-session-dialog';
      panel.setAttribute('aria-labelledby', 'account-session-title');
      const title = document.createElement('h2');
      title.id = 'account-session-title';
      title.textContent = '请重新确认登录状态';
      const detail = document.createElement('p');
      detail.className = 'account-session-detail';
      detail.setAttribute('role', 'status');
      const help = document.createElement('p');
      help.textContent = '当前页面保留在这里。重新登录原账号后，可以恢复该账号已暂存的草稿。';
      const actions = document.createElement('div');
      actions.className = 'account-session-actions';
      const login = document.createElement('a');
      login.className = 'primary-button';
      login.href = loginURL();
      login.textContent = '前往登录';
      const retry = document.createElement('button');
      retry.className = 'secondary-button';
      retry.type = 'button';
      retry.textContent = '重新连接';
      retry.addEventListener('click', () => checkSession());
      const backup = document.createElement('button');
      backup.className = 'text-button';
      backup.type = 'button';
      backup.textContent = '导出当前草稿';
      backup.hidden = typeof window.exportLocalDraft !== 'function';
      backup.addEventListener('click', () => window.exportLocalDraft());
      actions.append(login, retry, backup);
      panel.append(title, detail, help, actions);
      panel.addEventListener('cancel', (event) => event.preventDefault());
      document.body.append(panel);
    }
    panel.querySelector('.account-session-detail').textContent = message;
    if (!panel.open) panel.showModal();
  }

  async function checkSession() {
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await nativeFetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (response.status === 401) {
          if (id || privatePage) showSessionProblem('登录已过期或已退出，请登录后继续。');
          return null;
        }
        if (!response.ok) throw new Error('暂时无法确认登录状态，请检查连接后重试。');
        const value = await response.json();
        if (!value.user || !/^[a-f0-9]{32}$/.test(value.user.id) || typeof value.csrf_token !== 'string') {
          throw new Error('登录服务返回异常，请稍后重试。');
        }
        if (value.user.id !== id) {
          showSessionProblem('其他页面已切换账号。请重新打开页面，或登录原账号后继续。');
          return null;
        }
        session = value;
        blocked = false;
        if (panel?.open) panel.close();
        return value;
      } catch (error) {
        if (id || privatePage) showSessionProblem('暂时无法连接登录服务。当前内容仍保留，请稍后重新连接。');
        return null;
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  const ready = checkSession();

  async function accountFetch(input, options = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, options);
    const isPublic = url.pathname === '/api/sources' || url.pathname === '/api/library' || url.pathname.startsWith('/api/library/');
    if (isPublic) return nativeFetch(input, options);
    await ready;
    if (!session || blocked || !id) {
      showSessionProblem('请确认当前账号已登录，再继续操作。');
      throw new Error('请重新登录后继续。');
    }
    const headers = new Headers(options.headers || (typeof input === 'object' ? input.headers : undefined));
    headers.set('X-Account-ID', id);
    const method = (options.method || (typeof input === 'object' ? input.method : 'GET') || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-CSRF-Token', session.csrf_token);
    const response = await nativeFetch(input, { ...options, headers, credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) {
      showSessionProblem('登录状态已变化，请重新登录后继续。');
      throw new Error('登录状态已变化，请重新登录后继续。');
    }
    return response;
  }

  function storageKey(key) { return prefix + key; }
  function storage() {
    const target = window.localStorage;
    return {
      getItem: (key) => target.getItem(storageKey(key)),
      setItem: (key, value) => target.setItem(storageKey(key), value),
      removeItem: (key) => target.removeItem(storageKey(key)),
    };
  }
  window.Account = Object.freeze({ id, username, ready, fetch: accountFetch, storage, storageKey });

  const slot = document.querySelector('.account-controls');
  if (slot) {
    if (!id) {
      const login = document.createElement('a');
      login.href = loginURL();
      login.textContent = '登录 / 注册';
      slot.append(login);
    } else {
      const label = document.createElement('span');
      label.className = 'account-name';
      label.textContent = username;
      label.title = `当前账号：${username}`;
      const logout = document.createElement('button');
      logout.type = 'button';
      logout.textContent = '退出';
      logout.addEventListener('click', async () => {
        if (signingOut) return;
        flushDraft();
        if (typeof window.isLocalDraftSaved === 'function' && !window.isLocalDraftSaved()
          && !window.confirm('当前草稿尚未成功暂存。退出会离开页面，是否仍要退出？')) return;
        signingOut = true;
        logout.disabled = true;
        try {
          const response = await accountFetch('/api/auth/logout', { method: 'POST' });
          if (!response.ok) throw new Error('退出失败，请重试。');
          session = null;
          blocked = true;
          try { localStorage.setItem('cmit:auth-change', JSON.stringify({ user_id: null, at: Date.now() })); } catch {}
          location.assign('/login.html');
        } catch (error) {
          logout.textContent = '重试退出';
          logout.title = error.message;
          showSessionProblem(error.message);
        } finally {
          signingOut = false;
          logout.disabled = false;
        }
      });
      slot.append(label, logout);
    }
  }
  window.addEventListener('storage', (event) => {
    if (event.key === 'cmit:auth-change' || event.key === null) {
      if (privatePage) showSessionProblem('登录状态发生变化，正在重新确认…');
      checkSession();
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      if (privatePage) showSessionProblem('正在重新确认登录状态…');
      checkSession();
    }
  });
  window.addEventListener('focus', () => { if (!signingOut) checkSession(); });
}());

/* One manually entered trial record, kept in this browser only. No network submission. */
(function () {
  'use strict';

  const form = document.getElementById('trial-feedback-form');
  if (!form) return;
  const get = (id) => document.getElementById(id);
  const KEY = window.Account ? window.Account.storageKey('cmit:trial-feedback:v1') : 'cmit:trial-feedback:v1';
  const ROLES = { writer: '编写者', reviewer: '审阅者', visitor: '体验者' };
  const TASKS = { '': '未选择', 'first-review': '初次审阅', recheck: '复核', library: '查资料', other: '其他' };
  const RESULTS = { 'not-tried': '未尝试', independent: '独立完成', helped: '在帮助下完成', blocked: '遇到阻碍／未完成' };
  const STEPS = ['准备文稿与资料', '发起整篇审阅', '对照证据与原文', '保存人工意见', '修改后复核', '导出报告与回看档案'];
  const fields = {
    alias: get('trial-alias'), role: get('trial-role'), date: get('trial-date'), task: get('trial-task'),
    friction: get('trial-friction'), suggestion: get('trial-suggestion'),
  };
  const stepFields = STEPS.map((_, index) => get(`trial-step-${index + 1}`));
  const status = get('trial-feedback-status');
  const restore = get('trial-restore');
  const save = get('trial-save');
  const clear = get('trial-clear');
  const empty = { alias: '', role: '', date: '', task: '', steps: STEPS.map(() => 'not-tried'), friction: '', suggestion: '' };
  let baseline = JSON.stringify(empty);
  let baselineRaw = null;
  let baselineKnown = false;
  let pending = null;
  let savedAt = null;
  let corrupt = false;
  let conflict = false;
  let unavailable = false;

  function capture() {
    const value = {};
    for (const [key, field] of Object.entries(fields)) value[key] = field.value;
    value.steps = stepFields.map((field) => field.value);
    // Stable field order also makes an untouched restored record compare reliably.
    return { alias: value.alias, role: value.role, date: value.date, task: value.task,
      steps: value.steps, friction: value.friction, suggestion: value.suggestion };
  }

  function exactKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  }

  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000')) return false;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return value <= today;
  }

  function problem(value) {
    if (!exactKeys(value, ['alias', 'role', 'date', 'task', 'steps', 'friction', 'suggestion'])) return ['记录结构无效。', fields.role];
    if (typeof value.alias !== 'string' || value.alias.length > 60) return ['匿名代号最多填写 60 个字符。', fields.alias];
    if (typeof value.role !== 'string' || !Object.hasOwn(ROLES, value.role)) return ['请选择你这次体验的角色。', fields.role];
    if (!validDate(value.date)) return ['请填写实际测试日期，日期不能晚于今天。', fields.date];
    if (typeof value.task !== 'string' || !Object.hasOwn(TASKS, value.task)) return ['请选择有效的任务类型，或保留未选择。', fields.task];
    if (!Array.isArray(value.steps) || value.steps.length !== STEPS.length
      || value.steps.some((result) => typeof result !== 'string' || !Object.hasOwn(RESULTS, result))) return ['步骤结果无效，请重新选择。', stepFields[0]];
    if (value.steps.every((result) => result === 'not-tried')) return ['请先实际尝试至少一个步骤，再记录它的结果；未尝试不计为试用。', stepFields[0]];
    for (const key of ['friction', 'suggestion']) {
      if (typeof value[key] !== 'string' || value[key].length > 4000) return ['卡点和建议每项最多填写 4000 个字符。', fields[key]];
    }
    return null;
  }

  function parse(raw) {
    try {
      if (typeof raw !== 'string' || raw.length > 24000) return null;
      const value = JSON.parse(raw);
      if (!exactKeys(value, ['schema_version', 'provenance', 'storage_scope', 'submitted', 'server_saved', 'saved_at', 'feedback'])
        || value.schema_version !== 1 || value.provenance !== 'manual_trial_feedback'
        || value.storage_scope !== 'current_browser_only' || value.submitted !== false || value.server_saved !== false
        || typeof value.saved_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.saved_at)
        || !Number.isFinite(new Date(value.saved_at).getTime()) || new Date(value.saved_at).toISOString() !== value.saved_at
        || problem(value.feedback)) return null;
      return value;
    } catch (error) { return null; }
  }

  function read() {
    try {
      const raw = window.localStorage.getItem(KEY);
      unavailable = false;
      return { ok: true, raw };
    } catch (error) {
      unavailable = true;
      return { ok: false };
    }
  }

  function dirty() { return JSON.stringify(capture()) !== baseline; }

  function render(message, state) {
    restore.hidden = !pending || conflict;
    save.disabled = Boolean(pending || corrupt || conflict);
    clear.disabled = conflict;
    if (conflict) {
      message = '本机反馈已在其他页面发生变化。为避免覆盖，已暂停保存与清除。请先导出当前填写，再刷新页面读取最新记录。';
      state = 'conflict';
    } else if (corrupt) {
      message = '本机原有反馈无法读取，尚未覆盖。你可以导出当前填写，或确认清除本机反馈后重新保存。';
      state = 'error';
    } else if (!message) {
      if (pending) {
        message = '本机已有一条反馈，尚未自动填入。可点击“恢复本机反馈”后查看或导出；如需保存新的填写，请先确认清除旧记录。';
        state = 'pending';
      } else if (unavailable) {
        message = '本机存储暂不可用，填写仍保留在页面。可以重试保存，或直接导出文件；未提交到服务器。';
        state = 'error';
      } else if (dirty()) {
        message = '未保存：当前填写仅在此页面中，请点击“保存”或导出文件。';
        state = 'unsaved';
      } else if (savedAt) {
        message = `已保存本机（${new Date(savedAt).toLocaleString('zh-CN')}）。仅此浏览器可恢复，未提交到服务器。`;
        state = 'saved';
      } else {
        message = '尚未填写。完成一次实际体验后，再记录你的过程。';
        state = 'empty';
      }
    }
    status.textContent = message;
    status.dataset.state = state;
  }

  function unchangedStorage() {
    const current = read();
    if (!current.ok) { render(); return false; }
    if (!baselineKnown) {
      if (current.raw !== null) { conflict = true; render(); return false; }
      baselineKnown = true;
      baselineRaw = null;
    }
    if (current.raw !== baselineRaw) { conflict = true; render(); return false; }
    return true;
  }

  function checkedFeedback() {
    const feedback = capture();
    const issue = problem(feedback);
    if (issue) {
      render(`未保存：${issue[0]}`, 'invalid');
      issue[1].focus();
      return null;
    }
    return feedback;
  }

  function record(feedback, timestamp) {
    return { schema_version: 1, provenance: 'manual_trial_feedback', storage_scope: 'current_browser_only',
      submitted: false, server_saved: false, saved_at: timestamp, feedback };
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (pending || corrupt || conflict) { render(); return; }
    const feedback = checkedFeedback();
    if (!feedback || !unchangedStorage()) return;
    const timestamp = new Date().toISOString();
    const raw = JSON.stringify(record(feedback, timestamp));
    try {
      window.localStorage.setItem(KEY, raw);
      // Verify successful persistence before showing "saved".
      if (window.localStorage.getItem(KEY) !== raw) { conflict = true; render(); return; }
      baselineRaw = raw;
      baseline = JSON.stringify(feedback);
      savedAt = timestamp;
      unavailable = false;
      render();
    } catch (error) {
      unavailable = true;
      render('保存失败：浏览器未确认写入成功。当前填写仍在页面，可以导出文件后再处理本机存储。', 'error');
    }
  });

  restore.addEventListener('click', () => {
    if (!pending || conflict || !unchangedStorage()) return;
    if (dirty() && !window.confirm('恢复本机反馈会替换当前页面中尚未保存的填写。请先导出要保留的内容。确定恢复吗？')) return;
    // Recheck after the confirmation, which can leave time for another tab to save.
    if (!unchangedStorage()) return;
    for (const [key, field] of Object.entries(fields)) field.value = pending.feedback[key];
    stepFields.forEach((field, index) => { field.value = pending.feedback.steps[index]; });
    savedAt = pending.saved_at;
    baseline = JSON.stringify(capture());
    pending = null;
    render();
  });

  clear.addEventListener('click', () => {
    if (conflict || !unchangedStorage()) return;
    if (baselineRaw === null) { render('本机没有已保存的反馈。当前页面填写未被清除。', dirty() ? 'unsaved' : 'empty'); return; }
    if (!window.confirm('确定清除此浏览器保存的这一条试用反馈吗？清除后不能恢复。当前页面填写和其他审阅、草稿不会被删除。')) return;
    if (!unchangedStorage()) return;
    try {
      window.localStorage.removeItem(KEY);
      if (window.localStorage.getItem(KEY) !== null) { conflict = true; render(); return; }
      baselineRaw = null;
      baseline = JSON.stringify(empty);
      pending = null;
      savedAt = null;
      corrupt = false;
      unavailable = false;
      render('已清除本机反馈。当前页面填写仍保留，如需留存请重新保存或导出。', dirty() ? 'unsaved' : 'empty');
    } catch (error) {
      unavailable = true;
      render('清除失败：无法确认本机记录已删除。当前页面填写仍保留，可以导出文件。', 'error');
    }
  });

  function download(kind) {
    const feedback = checkedFeedback();
    if (!feedback) return;
    // Download remains available on storage failures, but must not claim a stale save is current.
    if (baselineKnown && !conflict) {
      const current = read();
      if (current.ok && current.raw !== baselineRaw) conflict = true;
    }
    const locallySaved = !pending && !conflict && !corrupt && !unavailable && savedAt !== null && !dirty();
    const data = { ...record(feedback, locallySaved ? savedAt : null),
      exported_at: new Date().toISOString(), locally_saved: locallySaved };
    let text = JSON.stringify(data, null, 2);
    if (kind === 'txt') {
      text = ['服饰核验系统 · 手工试用反馈', '来源：实际使用者手工填写；未经自动验证，不代表整体效果或试用人数。',
        '保存范围：当前浏览器；此文件为手动导出。未提交服务器（submitted=false，server_saved=false）。',
        `当前内容已保存本机：${locallySaved ? '是' : '否或无法确认'}`, `导出时间：${data.exported_at}`,
        `匿名代号：${feedback.alias.trim() || '未填写'}`, `体验角色：${ROLES[feedback.role]}`,
        `实际测试日期：${feedback.date}`, `任务类型：${TASKS[feedback.task]}`, '', '逐步体验（未尝试不计为完成）：',
        ...STEPS.map((label, index) => `${index + 1}. ${label}：${RESULTS[feedback.steps[index]]}`),
        '', '遇到的卡点：', feedback.friction || '未填写', '', '改进建议：', feedback.suggestion || '未填写', ''].join('\n');
    }
    let url = null;
    try {
      const blob = new Blob([text], { type: kind === 'txt' ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' });
      url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `trial-feedback-${feedback.date}.${kind}`;
      document.body.append(link);
      link.click();
      link.remove();
      render('已发起文件下载，请检查浏览器下载记录。导出不等于保存本机或提交服务器；尚未保存的填写仍会提示离页保护。', locallySaved ? 'saved' : 'unsaved');
    } catch (error) {
      render('导出失败，当前填写仍在页面。请检查浏览器下载设置，或手动复制内容留存。', 'error');
    } finally {
      if (url) window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  get('trial-export-txt').addEventListener('click', () => download('txt'));
  get('trial-export-json').addEventListener('click', () => download('json'));
  form.addEventListener('input', () => render());
  form.addEventListener('change', () => render());
  window.addEventListener('beforeunload', (event) => {
    if (dirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY && event.key !== null) return;
    if (baselineKnown && (event.key === null ? baselineRaw !== null : event.newValue !== baselineRaw)) {
      conflict = true;
      render();
    }
  });

  const initial = read();
  if (initial.ok) {
    baselineKnown = true;
    baselineRaw = initial.raw;
    if (initial.raw !== null) {
      pending = parse(initial.raw);
      corrupt = !pending;
    }
  }
  get('trial-export-txt').disabled = false;
  get('trial-export-json').disabled = false;
  render();
}());

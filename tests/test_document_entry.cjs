/* Upload-first workbench behavior against the real app scripts and disposable fixtures. */
const assert = require('node:assert/strict');
const harnessPath = require.resolve('./test_workflow_frontend.cjs');
const active = new Set();
async function fresh() {
  delete require.cache[harnessPath];
  const h = require(harnessPath);
  active.add(h);
  await h.flush();
  return h;
}
const node = (h, id) => h.ids.get(id);
const input = (h, value) => {
  node(h, 'document-preview').value = value;
  node(h, 'document-preview').events.input();
};
const upload = (h, name = '展签.docx') => {
  node(h, 'document-file').files = [{ name, size: 32 }];
  node(h, 'document-file').value = `C:\\fakepath\\${name}`;
  return node(h, 'document-file').events.change();
};

(async () => {
  // 1. A fresh workspace opens the file picker without first opening an empty editor.
  const initial = await fresh();
  assert.equal(node(initial, 'document-preview-box').hidden, true);
  assert.equal(node(initial, 'preview-empty').hidden, false);
  assert.equal(node(initial, 'document-import').dataset.hasDocument, 'false');
  assert.equal(node(initial, 'choose-document').disabled, false);
  let picked = 0;
  node(initial, 'document-file').events.click = () => { picked++; };
  node(initial, 'choose-document').click();
  assert.equal(picked, 1);
  assert.equal(node(initial, 'document-preview-box').hidden, true);

  // 2. Manual input focuses immediately, collapses only when empty, and never hides existing text.
  node(initial, 'manual-entry').click();
  assert.equal(node(initial, 'document-preview-box').hidden, false);
  assert.equal(node(initial, 'manual-entry').getAttribute('aria-expanded'), 'true');
  assert.equal(initial.document.activeElement.id, 'document-preview');
  node(initial, 'manual-entry').click();
  assert.equal(node(initial, 'document-preview-box').hidden, true);
  node(initial, 'manual-entry').click();
  input(initial, '这件棉袍采用对襟设计。');
  assert.equal(node(initial, 'manual-entry').hidden, true);
  initial.run('toggleManualEntry()');
  assert.equal(node(initial, 'document-preview-box').hidden, false);
  input(initial, '');
  assert.equal(node(initial, 'document-preview-box').hidden, false, 'Deleting the last character must preserve editing focus');
  node(initial, 'manual-entry').click();
  assert.equal(node(initial, 'document-preview-box').hidden, true);

  // 3. Busy work locks both entry actions, preventing a second file picker or empty editor toggle.
  for (const busy of ['workspaceInitializing', 'activeUpload', 'activeReview', 'activeHistory', 'activeSave', 'activeSourceSelection', 'activeExampleLoad']) {
    initial.run(`${busy} = true; syncWorkspace()`);
    assert.equal(node(initial, 'choose-document').disabled, true, busy);
    assert.equal(node(initial, 'manual-entry').disabled, true, busy);
    node(initial, 'choose-document').click();
    node(initial, 'manual-entry').click();
    assert.equal(picked, 1, busy);
    assert.equal(node(initial, 'document-preview-box').hidden, true, busy);
    initial.run(`${busy} = false; syncWorkspace()`);
  }

  // 4. Extraction failure is visible on the upload card and permits the same file to be retried.
  const failed = await fresh();
  failed.extractResponse = failed.response({ error: '文稿读取失败，请重试。' }, 503);
  await upload(failed);
  assert.equal(node(failed, 'document-preview-box').hidden, true);
  assert.equal(node(failed, 'document-file').value, '');
  assert.match(node(failed, 'document-status').textContent, /读取失败/);
  assert.equal(node(failed, 'choose-document').disabled, false);
  failed.extractResponse = failed.response({ text: '从文件读取的正文。' });
  failed.run('selectWorkspaceTab(1)');
  await upload(failed);
  assert.equal(node(failed, 'preview-view').hidden, false);
  assert.equal(node(failed, 'document-preview-box').hidden, false);
  assert.equal(node(failed, 'document-preview').value, '从文件读取的正文。');
  assert.equal(node(failed, 'choose-document').textContent, '更换文件');
  assert.equal(node(failed, 'document-import').dataset.hasDocument, 'true');
  assert.equal(node(failed, 'manual-entry').hidden, true);
  assert.equal(failed.requests.filter(p => p === '/api/extract').length, 2);

  // 5. Failed replacement preserves the existing editor, draft and text.
  failed.run('flushDraftSave()');
  const stored = failed.storageData.get('cmit:workspace-draft:v1:new');
  failed.extractResponse = failed.response({ error: '暂时无法提取。' }, 503);
  await upload(failed, '替换文稿.pdf');
  assert.equal(node(failed, 'document-preview').value, '从文件读取的正文。');
  assert.equal(node(failed, 'document-preview-box').hidden, false);
  assert.equal(failed.storageData.get('cmit:workspace-draft:v1:new'), stored);

  // 6. Local recovery and archive loading automatically expose their text.
  const restored = await fresh();
  restored.storageData.set('cmit:workspace-draft:v1:new', stored);
  restored.run('initializeDrafts(); recoverLocalDraft()');
  assert.equal(node(restored, 'document-preview-box').hidden, false);
  assert.equal(node(restored, 'document-preview').value, '从文件读取的正文。');
  const archive = await fresh();
  archive.run('adoptRecord(validateDoneEvent(clone(record)))');
  assert.equal(node(archive, 'document-preview-box').hidden, false);
  assert.equal(node(archive, 'document-preview').value, archive.record.normalized_text);

  // 7. Explicit clear restores the upload-first state and removes stale extraction messages.
  failed.run('handleClear()');
  assert.equal(node(failed, 'document-preview-box').hidden, true);
  assert.equal(node(failed, 'preview-empty').hidden, false);
  assert.equal(node(failed, 'document-status').textContent, '');
  assert.equal(node(failed, 'document-import').dataset.hasDocument, 'false');
  assert.equal(node(failed, 'manual-entry').hidden, false);
  assert.equal(node(failed, 'manual-entry').getAttribute('aria-expanded'), 'false');
  assert.equal(node(failed, 'choose-document').textContent, '选择 Word 文件');
  console.log('PASS: 7 upload-first entry scenarios, including manual editing, busy locks, retry, replacement preservation, recovery and clear');
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => active.forEach(h => h.close()));

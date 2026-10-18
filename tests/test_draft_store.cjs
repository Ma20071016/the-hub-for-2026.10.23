'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require('../frontend/draft-store.js');

const PREFIX = 'cmit:workspace-draft:v1:';
const REVIEW_A = 'a'.repeat(32);
const REVIEW_B = 'b'.repeat(32);

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function snapshot(reviewId = null) {
  const decisions = reviewId === null ? [] : [
    { index: 0, state: 'unreviewed', note: '' },
    { index: 1, state: 'pending', note: '需要核对衣领。' },
  ];
  return {
    schema_version: 1,
    saved_at: '2026-10-17T09:10:11.123Z',
    review_id: reviewId,
    title: '服饰审阅草稿',
    text: '正文修改内容。',
    source_id: 43,
    record_text: reviewId === null ? null : '原审阅正文。',
    decisions_revision: reviewId === null ? null : 2,
    base_decisions: structuredClone(decisions),
    decisions,
    sentence_edit: null,
  };
}

test('exports the same browser API without requiring CommonJS', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/draft-store.js'), 'utf8'), context);
  assert.equal(typeof context.window.DraftStore.create, 'function');
  assert.equal(context.window.DraftStore.create(memoryStorage).read().ok, true);
});

test('new draft and each review have isolated keys; reads and writes preserve content', () => {
  const storage = memoryStorage();
  const store = create(() => storage);
  assert.deepEqual(store.read(), { ok: true, draft: null, raw: null });
  for (const reviewId of [null, REVIEW_A, REVIEW_B]) {
    const input = snapshot(reviewId);
    const saved = store.write(input);
    assert.equal(saved.ok, true);
    assert.deepEqual(saved.draft, input);
    assert.deepEqual(store.read(reviewId), saved);
    const key = PREFIX + (reviewId === null ? 'new' : `review:${reviewId}`);
    assert.equal(storage.values.get(key), saved.raw);
  }
  assert.equal(storage.values.size, 3);
});

test('valid blank drafts and nullable source selection survive reload', () => {
  const store = create(memoryStorage);
  const input = snapshot();
  Object.assign(input, { title: '', text: '', source_id: null });
  assert.equal(store.write(input).ok, true);
});

test('saved snapshots are independent copies of caller objects', () => {
  const storage = memoryStorage();
  const store = create(() => storage);
  const input = snapshot(REVIEW_A);
  input.sentence_edit = { index: 1, base: '待改原句', text: '未应用的修改', conflict: true };
  const saved = store.write(input);
  assert.equal(saved.ok, true);
  input.decisions[0].note = 'late mutation';
  input.sentence_edit.text = 'late edit';
  assert.equal(saved.draft.decisions[0].note, '');
  assert.equal(saved.draft.sentence_edit.text, '未应用的修改');
  saved.draft.decisions[1].note = 'returned mutation';
  assert.equal(store.read(REVIEW_A).draft.decisions[1].note, '需要核对衣领。');
});

test('stale tab cannot overwrite or remove a draft saved by another tab', () => {
  const storage = memoryStorage();
  const tabA = create(() => storage);
  const tabB = create(() => storage);
  const initial = tabA.write(snapshot());
  const stale = tabB.read();
  const input = { ...initial.draft, text: 'A 标签页的新修改' };
  const fresh = tabA.write(input, initial.raw);
  assert.equal(fresh.ok, true);
  assert.deepEqual(tabB.write({ ...stale.draft, text: 'B 标签页的修改' }, stale.raw),
    { ok: false, reason: 'conflict', raw: fresh.raw });
  assert.deepEqual(tabB.remove(null, stale.raw), { ok: false, reason: 'conflict', raw: fresh.raw });
  assert.equal(tabB.read().draft.text, input.text);
  assert.deepEqual(tabB.remove(null, fresh.raw), { ok: true, draft: null, raw: null });
  assert.equal(tabA.write(input, fresh.raw).reason, 'conflict');
});

test('default expectedRaw cannot replace an existing draft; removal only removes its own key', () => {
  const storage = memoryStorage();
  const store = create(() => storage);
  const fresh = store.write(snapshot(REVIEW_A));
  store.write(snapshot(REVIEW_B));
  assert.equal(store.write(snapshot(REVIEW_A)).reason, 'conflict');
  assert.equal(store.remove(REVIEW_A).reason, 'conflict');
  assert.equal(store.remove(REVIEW_A, fresh.raw).ok, true);
  assert.equal(store.read(REVIEW_B).ok, true);
  assert.notEqual(store.read(REVIEW_B).draft, null);
  assert.deepEqual(store.remove(), { ok: true, draft: null, raw: null });
});

test('invalid JSON and cross-review contents are preserved with their raw tokens', () => {
  const storage = memoryStorage();
  const store = create(() => storage);
  const key = PREFIX + `review:${REVIEW_A}`;
  for (const raw of ['{', 'null', '[]', JSON.stringify(snapshot(REVIEW_B)), JSON.stringify(snapshot())]) {
    storage.values.set(key, raw);
    assert.deepEqual(store.read(REVIEW_A), { ok: false, reason: 'invalid', raw });
    assert.equal(storage.values.get(key), raw);
  }
  assert.equal(store.remove(REVIEW_A, storage.values.get(key)).ok, true);
});

test('unknown schemas, missing fields and unexpected fields are rejected without mutation', () => {
  const storage = memoryStorage();
  const store = create(() => storage);
  const inputs = [null, [], {}, { ...snapshot(), schema_version: 2 }, { ...snapshot(), unexpected: true }];
  for (const name of Object.keys(snapshot())) {
    const input = snapshot();
    delete input[name];
    inputs.push(input);
  }
  for (const input of inputs) assert.equal(store.write(input).reason, 'invalid');
  assert.equal(storage.values.size, 0);
});

test('invalid identifiers, revisions, timestamps, and source IDs cannot be persisted', () => {
  const store = create(memoryStorage);
  const invalids = {
    review_id: ['', 'not-an-id', 'A'.repeat(32), 123],
    source_id: [0, -1, 1.1, '43', Infinity, Number.MAX_SAFE_INTEGER + 1],
    decisions_revision: [null, -1, 1.2, '2', Infinity, Number.MAX_SAFE_INTEGER + 1],
    saved_at: ['', 'not-a-date', '2026-02-30T09:10:11.123Z', '2026-10-17', 0],
  };
  for (const [field, values] of Object.entries(invalids)) {
    for (const value of values) assert.equal(store.write({ ...snapshot(REVIEW_A), [field]: value }).reason, 'invalid', `${field}: ${value}`);
  }
  for (const reviewId of ['bad', 43, 'A'.repeat(32)]) {
    assert.equal(store.read(reviewId).reason, 'invalid');
    assert.equal(store.remove(reviewId).reason, 'invalid');
  }
  assert.equal(store.write(snapshot(), {}).reason, 'invalid');
  assert.equal(store.remove(null, 12).reason, 'invalid');
});

test('new-draft and reviewed-draft fields cannot be mixed', () => {
  const store = create(memoryStorage);
  for (const change of [
    { record_text: '' }, { decisions_revision: 0 },
    { decisions: [{ index: 0, state: 'pending', note: '' }], base_decisions: [{ index: 0, state: 'pending', note: '' }] },
    { sentence_edit: { index: 0, base: '', text: '', conflict: false } },
  ]) assert.equal(store.write({ ...snapshot(), ...change }).reason, 'invalid');
  assert.equal(store.write({ ...snapshot(REVIEW_A), record_text: null }).reason, 'invalid');
});

test('decision lists validate every entry, state, sequential index and equal length', () => {
  const store = create(memoryStorage);
  const invalidDecisions = [
    null, {}, [null], [{ index: 1, state: 'pending', note: '' }],
    [{ index: 0, state: 'wrong', note: '' }], [{ index: 0, state: 'confirmed', note: 12 }],
    [{ index: 0, state: 'dismissed', note: '', extra: true }], new Array(2),
  ];
  for (const decisions of invalidDecisions) {
    assert.equal(store.write({ ...snapshot(REVIEW_A), decisions, base_decisions: decisions }).reason, 'invalid');
  }
  const unequal = snapshot(REVIEW_A);
  unequal.decisions.pop();
  assert.equal(store.write(unequal).reason, 'invalid');
  const input = snapshot(REVIEW_A);
  input.decisions = Array.from({ length: 5000 }, (_, index) => ({ index, state: 'unreviewed', note: '' }));
  input.base_decisions = structuredClone(input.decisions);
  assert.equal(store.write(input).ok, true);
  input.decisions.push({ index: 5000, state: 'pending', note: '' });
  input.base_decisions.push({ index: 5000, state: 'pending', note: '' });
  assert.equal(store.write(input).reason, 'invalid');
});

test('text limits count Unicode characters and reject only values above each boundary', () => {
  for (const [field, maximum] of [['title', 120], ['text', 50000], ['record_text', 50000]]) {
    const input = snapshot(REVIEW_A);
    const store = create(memoryStorage);
    input[field] = '𠮷'.repeat(maximum);
    assert.equal(store.write(input).ok, true, field);
    input[field] += '字';
    assert.equal(store.write(input).reason, 'invalid', field);
    input[field] = null;
    assert.equal(store.write(input).reason, 'invalid', field);
  }
  for (const field of ['decisions', 'base_decisions']) {
    const input = snapshot(REVIEW_A);
    const store = create(memoryStorage);
    input[field][0].note = '😀'.repeat(2000);
    assert.equal(store.write(input).ok, true);
    input[field][0].note += '字';
    assert.equal(store.write(input).reason, 'invalid');
  }
});

test('unfinished sentence edits validate their sentence index, content and conflict flag', () => {
  const store = create(memoryStorage);
  const base = { index: 0, base: '原句', text: '修改句', conflict: false };
  assert.equal(store.write({ ...snapshot(REVIEW_A), sentence_edit: base }).ok, true);
  for (const edit of [
    {}, [], { ...base, index: -1 }, { ...base, index: 2 }, { ...base, index: 0.5 },
    { ...base, conflict: 'false' }, { ...base, base: null }, { ...base, text: null },
    { ...base, base: '字'.repeat(50001) }, { ...base, text: '字'.repeat(50001) },
  ]) assert.equal(store.write({ ...snapshot(REVIEW_A), sentence_edit: edit }).reason, 'invalid');
  const boundary = { ...base, base: '𠮷'.repeat(50000), text: '😀'.repeat(50000), conflict: true };
  assert.equal(store.write({ ...snapshot(REVIEW_A), sentence_edit: boundary }).ok, true);
});

test('blocked storage access, quota errors and removal failures are recoverable', () => {
  for (const getStorage of [undefined, () => null, () => ({}), () => { throw new Error('SecurityError'); }]) {
    const store = create(getStorage);
    assert.equal(store.read().reason, 'unavailable');
    assert.equal(store.write(snapshot()).reason, 'unavailable');
    assert.equal(store.remove().reason, 'unavailable');
  }
  const storage = memoryStorage();
  const store = create(() => storage);
  const initial = store.write(snapshot());
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.deepEqual(store.write({ ...snapshot(), text: '更新正文' }, initial.raw),
    { ok: false, reason: 'unavailable', raw: initial.raw });
  assert.equal(store.read().draft.text, initial.draft.text);
  storage.removeItem = () => { throw new Error('SecurityError'); };
  assert.deepEqual(store.remove(null, initial.raw), { ok: false, reason: 'unavailable', raw: initial.raw });
  storage.getItem = () => { throw new Error('SecurityError'); };
  assert.equal(store.read().reason, 'unavailable');
  assert.equal(store.write(snapshot()).reason, 'unavailable');
  assert.equal(store.remove().reason, 'unavailable');
});

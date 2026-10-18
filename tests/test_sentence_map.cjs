'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/sentence-map.js'), 'utf8'), context);
const map = context.window.SentenceMap;
const tests = [];
const test = (name, body) => tests.push({ name, body });
const plain = value => JSON.parse(JSON.stringify(value));

function record(text, sentences) {
  let cursor = 0;
  return sentences.map((sentence, index) => {
    const start = text.indexOf(sentence, cursor);
    assert.ok(start >= 0, `Fixture sentence missing: ${sentence}`);
    cursor = start + sentence.length;
    return { index, sentence, sentence_start: Array.from(text.slice(0, start)).length,
      sentence_end: Array.from(text.slice(0, cursor)).length };
  });
}

function create(text, sentences) {
  return map.create(text, record(text, sentences));
}

function span(state, index, expectedText, status) {
  const range = map.locate(state, index);
  assert.ok(range, `Sentence ${index} should be locatable`);
  assert.equal(state.text.slice(range.start, range.end), expectedText);
  if (status) assert.equal(range.status, status);
  return range;
}

test('Python codepoint offsets become UTF-16 textarea offsets without changing records', () => {
  const text = '🧵说明\n甲衣含🪡。乙帽。';
  const results = record(text, ['甲衣含🪡。', '乙帽。']);
  const saved = JSON.stringify(results);
  Object.freeze(results);
  results.forEach(Object.freeze);
  const state = map.create(text, results);
  const first = span(state, 0, '甲衣含🪡。', 'unchanged');
  assert.equal(first.start, 5);
  assert.equal(first.end, 11);
  span(state, 1, '乙帽。', 'unchanged');
  assert.equal(JSON.stringify(results), saved);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.ranges[0]), true);
});

test('invalid initial indexes, offsets and mismatched text never become locatable', () => {
  const results = [
    { index: 0, sentence: '错误', sentence_start: 0, sentence_end: 2 },
    { index: 1, sentence: '甲。', sentence_start: -1, sentence_end: 2 },
    { index: 2, sentence: '乙。', sentence_start: 2, sentence_end: 99 },
    { index: 3, sentence: '甲。', sentence_start: 0.5, sentence_end: 2 },
    { index: -1, sentence: '甲。', sentence_start: 0, sentence_end: 2 },
  ];
  const state = map.create('甲。乙。', results);
  results.forEach(item => assert.equal(map.locate(state, item.index), null));
});

test('duplicate indexes and overlapping initial spans are rejected together', () => {
  const state = map.create('甲衣。乙帽。尾。', [
    { index: 0, sentence: '甲衣。', sentence_start: 0, sentence_end: 3 },
    { index: 1, sentence: '衣。', sentence_start: 1, sentence_end: 3 },
    { index: 2, sentence: '乙帽。', sentence_start: 3, sentence_end: 6 },
    { index: 2, sentence: '尾。', sentence_start: 6, sentence_end: 8 },
  ]);
  assert.ok(state.ranges.every(item => item.status === 'unavailable'));
});

test('validated interior replacement tracks edited text and shifts later sentences', () => {
  const original = create('甲衣是棉。乙帽。', ['甲衣是棉。', '乙帽。']);
  const next = map.update(original, '甲衣是蓝色棉。乙帽。', { start: 3, end: 3 });
  span(next, 0, '甲衣是蓝色棉。', 'edited');
  assert.equal(span(next, 1, '乙帽。', 'unchanged').start, 7);
  span(original, 0, '甲衣是棉。', 'unchanged');
});

test('unique inferred edits track a sentence without a beforeinput hint', () => {
  let state = create('甲衣采用棉布。乙帽。', ['甲衣采用棉布。', '乙帽。']);
  state = map.update(state, '甲衣采用蓝色棉布。乙帽。');
  span(state, 0, '甲衣采用蓝色棉布。', 'edited');
  span(state, 1, '乙帽。', 'unchanged');
});

test('deleting one of identical sentences without a hint invalidates both identities', () => {
  let state = create('甲。甲。尾。', ['甲。', '甲。', '尾。']);
  state = map.update(state, '甲。尾。');
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '尾。', 'unchanged');
});

test('a validated hint distinguishes deletion among repeated sentences', () => {
  let state = create('甲。甲。尾。', ['甲。', '甲。', '尾。']);
  state = map.update(state, '甲。尾。', { start: 0, end: 2 });
  assert.equal(map.locate(state, 0), null);
  assert.equal(span(state, 1, '甲。', 'unchanged').start, 0);
  span(state, 2, '尾。', 'unchanged');
});

test('a validated edit of a different duplicate overrides an identical-text history snapshot', () => {
  const original = '甲。甲。尾。';
  let state = create(original, ['甲。', '甲。', '尾。']);
  state = map.update(state, '甲。尾。', { start: 0, end: 2 });
  assert.equal(map.locate(state, 0), null);
  span(state, 1, '甲。', 'unchanged');
  state = map.update(state, original);
  state = map.update(state, '甲。尾。', { start: 2, end: 4 });
  assert.equal(span(state, 0, '甲。', 'unchanged').start, 0);
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '尾。', 'unchanged');
});

test('an ordinary unhinted duplicate deletion cannot restore an earlier identical-text identity', () => {
  const original = '甲。甲。尾。';
  let state = create(original, ['甲。', '甲。', '尾。']);
  state = map.update(state, '甲。尾。', { start: 0, end: 2 });
  assert.equal(map.locate(state, 0), null);
  span(state, 1, '甲。', 'unchanged');
  state = map.update(state, original);
  state = map.update(state, '甲。尾。');
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '尾。', 'unchanged');
});

test('undo to a text with historically different duplicate identities restores only shared safe ranges', () => {
  const original = '甲。甲。尾。';
  let state = create(original, ['甲。', '甲。', '尾。']);
  state = map.update(state, '甲。尾。', { start: 0, end: 2 });
  state = map.update(state, original);
  state = map.update(state, '甲。尾。', { start: 2, end: 4 });
  span(state, 0, '甲。', 'unchanged');
  assert.equal(map.locate(state, 1), null);
  state = map.update(state, '甲。新尾。', { start: 2, end: 2 });
  state = map.update(state, '甲。尾。', { inputType: 'historyUndo' });
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '尾。', 'unchanged');
});

test('a hint with mismatching prefix or suffix is discarded', () => {
  let state = create('甲。甲。尾。', ['甲。', '甲。', '尾。']);
  state = map.update(state, '甲。尾。', { start: 4, end: 6 });
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '尾。', 'unchanged');
});

test('insertion at a shared sentence boundary cannot be swallowed by either neighbor', () => {
  let state = create('甲。乙。丙。', ['甲。', '乙。', '丙。']);
  state = map.update(state, '甲。新句。乙。丙。', { start: 2, end: 2 });
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '丙。', 'unchanged');
});

test('insertion directly before the first sentence invalidates its boundary', () => {
  let state = create('甲。乙。', ['甲。', '乙。']);
  state = map.update(state, '新句。甲。乙。', { start: 0, end: 0 });
  assert.equal(map.locate(state, 0), null);
  span(state, 1, '乙。', 'unchanged');
});

test('insertion outside sentence ranges shifts them without absorbing the inserted text', () => {
  let state = create('说明\n甲。乙。', ['甲。', '乙。']);
  state = map.update(state, '🧵说明\n甲。乙。', { start: 0, end: 0 });
  assert.equal(span(state, 0, '甲。', 'unchanged').start, 5);
  span(state, 1, '乙。', 'unchanged');
});

test('cross-sentence replacement invalidates every crossed sentence but preserves the tail', () => {
  let state = create('甲衣。乙帽。丙靴。', ['甲衣。', '乙帽。', '丙靴。']);
  state = map.update(state, '甲合并帽。丙靴。', { start: 1, end: 4 });
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '丙靴。', 'unchanged');
});

test('whole document replacement never guesses locations from surviving repeated words', () => {
  let state = create('甲衣。乙帽。', ['甲衣。', '乙帽。']);
  state = map.update(state, '乙帽。新的甲衣。', { start: 0, end: state.text.length });
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
});

test('explicit sentence editing preserves a replacement spanning a single-sentence document', () => {
  let state = create('甲衣。', ['甲衣。']);
  state = map.update(state, '新🧵棉袍。', { start: 0, end: 3, sentenceIndex: 0 });
  const range = span(state, 0, '新🧵棉袍。', 'edited');
  assert.equal(range.start, 0);
  assert.equal(range.end, 6);
  assert.equal(range.original, '甲衣。');
});

test('explicit whole-sentence replacement keeps the correct duplicate and shifts neighbors', () => {
  let state = create('甲。甲。尾。', ['甲。', '甲。', '尾。']);
  state = map.update(state, '甲。蓝色衣。尾。', { start: 2, end: 4, sentenceIndex: 1 });
  span(state, 0, '甲。', 'unchanged');
  assert.equal(span(state, 1, '蓝色衣。', 'edited').start, 2);
  assert.equal(span(state, 2, '尾。', 'unchanged').start, 6);
});

test('explicit sentence replacement takes precedence over an earlier unavailable snapshot of the same text', () => {
  let state = create('甲衣。', ['甲衣。']);
  state = map.update(state, '全新稿。', { start: 0, end: 3 });
  assert.equal(map.locate(state, 0), null);
  state = map.update(state, '甲衣。');
  state = map.update(state, '全新稿。', { start: 0, end: 3, sentenceIndex: 0 });
  span(state, 0, '全新稿。', 'edited');
});

test('explicit sentence editing still makes an empty whole-sentence replacement unavailable', () => {
  let state = create('甲。甲。尾。', ['甲。', '甲。', '尾。']);
  state = map.update(state, '甲。尾。', { start: 2, end: 4, sentenceIndex: 1 });
  span(state, 0, '甲。', 'unchanged');
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '尾。', 'unchanged');
});

test('sentenceIndex cannot preserve a different sentence or a replacement crossing its boundary', () => {
  const original = create('甲衣。乙帽。', ['甲衣。', '乙帽。']);
  const wrongIndex = map.update(original, '新衣。乙帽。', { start: 0, end: 3, sentenceIndex: 1 });
  assert.equal(map.locate(wrongIndex, 0), null);
  span(wrongIndex, 1, '乙帽。', 'unchanged');
  const crossed = map.update(original, '新帽。', { start: 0, end: 4, sentenceIndex: 0 });
  assert.equal(map.locate(crossed, 0), null);
  assert.equal(map.locate(crossed, 1), null);
});

test('an unvalidated sentenceIndex hint cannot turn inferred whole-sentence replacement into a saved identity', () => {
  let state = create('甲衣。乙帽。', ['甲衣。', '乙帽。']);
  state = map.update(state, '新文！乙帽。', { start: 3, end: 6, sentenceIndex: 0 });
  assert.equal(map.locate(state, 0), null);
  span(state, 1, '乙帽。', 'unchanged');
});

test('complete sentence deletion makes that sentence unavailable', () => {
  let state = create('甲衣。乙帽。', ['甲衣。', '乙帽。']);
  state = map.update(state, '乙帽。', { start: 0, end: 3 });
  assert.equal(map.locate(state, 0), null);
  span(state, 1, '乙帽。', 'unchanged');
});

test('restoring original text resets all ranges after destructive changes', () => {
  const text = '甲衣。乙帽。';
  let state = create(text, ['甲衣。', '乙帽。']);
  state = map.update(state, '全新稿。', { start: 0, end: text.length });
  state = map.update(state, text);
  span(state, 0, '甲衣。', 'unchanged');
  span(state, 1, '乙帽。', 'unchanged');
});

test('undo and redo restore exact earlier mappings even when the earlier draft was edited', () => {
  let state = create('甲衣。乙帽。', ['甲衣。', '乙帽。']);
  state = map.update(state, '甲棉衣。乙帽。', { start: 1, end: 1 });
  const edited = state.text;
  state = map.update(state, '甲合并帽。', { start: 1, end: 5 });
  const merged = state.text;
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
  state = map.update(state, edited, { inputType: 'historyUndo' });
  span(state, 0, '甲棉衣。', 'edited');
  span(state, 1, '乙帽。', 'unchanged');
  state = map.update(state, merged, { inputType: 'historyRedo' });
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
});

test('emoji replacement with a hint inside a surrogate pair falls back safely', () => {
  let state = create('甲🧵衣。乙帽。', ['甲🧵衣。', '乙帽。']);
  state = map.update(state, '甲🪡衣。乙帽。', { start: 2, end: 3 });
  span(state, 0, '甲🪡衣。', 'edited');
  span(state, 1, '乙帽。', 'unchanged');
  assert.equal(state.ranges[0].end, 5);
});

test('repeated emoji deletion without a hint cannot choose the wrong identical sentence', () => {
  let state = create('🧵。🧵。尾。', ['🧵。', '🧵。', '尾。']);
  state = map.update(state, '🧵。尾。');
  assert.equal(map.locate(state, 0), null);
  assert.equal(map.locate(state, 1), null);
  span(state, 2, '尾。', 'unchanged');
});

test('ambiguous repeated characters wholly inside one sentence still have safe outer bounds', () => {
  let state = create('甲衣红红红。乙帽。', ['甲衣红红红。', '乙帽。']);
  state = map.update(state, '甲衣红红。乙帽。');
  span(state, 0, '甲衣红红。', 'edited');
  span(state, 1, '乙帽。', 'unchanged');
});

test('an unchanged input event preserves unavailable states without mutation', () => {
  let state = create('甲。乙。', ['甲。', '乙。']);
  state = map.update(state, '甲。新。乙。', { start: 2, end: 2 });
  const before = plain(state);
  const next = map.update(state, state.text, { start: 0, end: 0 });
  assert.deepEqual(plain(next), before);
  assert.deepEqual(plain(state), before);
});

test('locate returns an isolated copy and rejects unknown indexes or states', () => {
  const state = create('甲。', ['甲。']);
  const range = map.locate(state, 0);
  range.start = 999;
  assert.equal(map.locate(state, 0).start, 0);
  assert.equal(map.locate(state, 1), null);
  assert.equal(map.locate(state, '0'), null);
  assert.equal(map.locate({}, 0), null);
});

let failures = 0;
for (const { name, body } of tests) {
  try {
    body();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`FAIL ${name}\n${error.stack}\n`);
  }
}
process.stdout.write(`${tests.length - failures}/${tests.length} sentence-map tests passed.\n`);
if (failures) process.exitCode = 1;

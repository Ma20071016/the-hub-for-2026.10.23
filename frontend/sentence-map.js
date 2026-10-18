/* Track saved sentence spans through textarea edits without changing records.
 * Input offsets are Python Unicode character offsets; exposed ranges use UTF-16.
 * States are immutable and belong to this tracker instance (not JSON snapshots).
 * Ambiguous or fully removed spans become unavailable, never guessed by search.
 */
(function (global) {
  'use strict';

  const metadata = new WeakMap();
  const SNAPSHOT_LIMIT = 128;

  function unavailable(range) {
    return { index: range.index, start: null, end: null, original: range.original, status: 'unavailable' };
  }

  function copyRanges(ranges) {
    return ranges.map(range => ({ ...range }));
  }

  function sharedRanges(previous, current) {
    return current.map((range, position) => {
      const old = previous[position];
      return old && old.index === range.index && old.original === range.original &&
        old.start === range.start && old.end === range.end && old.status === range.status
        ? { ...range } : unavailable(range);
    });
  }

  function makeState(text, ranges, meta) {
    const frozenRanges = Object.freeze(ranges.map(range => Object.freeze({ ...range })));
    const state = Object.freeze({ text, ranges: frozenRanges });
    metadata.set(state, meta);
    return state;
  }

  function isBoundary(text, offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
    if (offset === 0 || offset === text.length) return true;
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset);
    return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF);
  }

  function create(text, results) {
    if (typeof text !== 'string' || !Array.isArray(results)) {
      throw new TypeError('SentenceMap.create requires text and a results array.');
    }
    const offsets = [0];
    for (const character of text) offsets.push(offsets[offsets.length - 1] + character.length);
    const ranges = results.map(result => {
      const item = result || {};
      const range = {
        index: item.index, start: null, end: null,
        original: typeof item.sentence === 'string' ? item.sentence : '', status: 'unavailable',
      };
      const start = item.sentence_start;
      const end = item.sentence_end;
      if (!Number.isSafeInteger(item.index) || item.index < 0 || !range.original ||
          !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || end <= start || end >= offsets.length) return range;
      if (text.slice(offsets[start], offsets[end]) !== range.original) return range;
      return { ...range, start: offsets[start], end: offsets[end], status: 'unchanged' };
    });

    // Neither duplicate indexes nor overlapping initial spans identify one
    // unambiguous saved sentence. Invalidate every participant, not just one.
    const invalid = new Set();
    const indexes = new Map();
    ranges.forEach((range, position) => {
      if (indexes.has(range.index)) {
        invalid.add(position);
        invalid.add(indexes.get(range.index));
      } else indexes.set(range.index, position);
    });
    const ordered = ranges.map((range, position) => ({ range, position }))
      .filter(item => item.range.status !== 'unavailable')
      .sort((left, right) => left.range.start - right.range.start);
    let farthest = null;
    for (const item of ordered) {
      if (farthest && item.range.start < farthest.range.end) {
        invalid.add(item.position);
        invalid.add(farthest.position);
      }
      if (!farthest || item.range.end > farthest.range.end) farthest = item;
    }
    const validRanges = ranges.map((range, position) => invalid.has(position) ? unavailable(range) : range);
    const baseline = { text, ranges: copyRanges(validRanges) };
    return makeState(text, validRanges, { baseline, snapshots: [baseline] });
  }

  function hintedEdit(oldText, newText, hint) {
    if (!hint || typeof hint !== 'object') return null;
    const { start, end } = hint;
    if (!isBoundary(oldText, start) || !isBoundary(oldText, end) || end < start) return null;
    const inserted = newText.length - (oldText.length - (end - start));
    if (inserted < 0 || !isBoundary(newText, start) || !isBoundary(newText, start + inserted)) return null;
    if (oldText.slice(0, start) !== newText.slice(0, start) ||
        oldText.slice(end) !== newText.slice(start + inserted)) return null;
    return [{ start, end, inserted,
      sentenceIndex: Number.isSafeInteger(hint.sentenceIndex) ? hint.sentenceIndex : null }];
  }

  function inferredEdits(oldText, newText) {
    const minimumLength = Math.min(oldText.length, newText.length);
    let prefix = 0;
    while (prefix < minimumLength && oldText[prefix] === newText[prefix]) prefix += 1;
    while (!isBoundary(oldText, prefix) || !isBoundary(newText, prefix)) prefix -= 1;
    let suffix = 0;
    while (suffix < minimumLength &&
        oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix += 1;
    while (!isBoundary(oldText, oldText.length - suffix) ||
        !isBoundary(newText, newText.length - suffix)) suffix -= 1;

    // Prefix and suffix may overlap for repeated text. Keep both extreme valid
    // placements of the shortest single replacement, rather than assigning a
    // deletion/insertion to whichever duplicate a greedy prefix scan reaches.
    const delta = newText.length - oldText.length;
    const removed = Math.max(0, oldText.length - prefix - suffix, -delta);
    const inserted = removed + delta;
    let first = Math.max(0, oldText.length - suffix - removed);
    let last = Math.min(prefix, oldText.length - removed);
    const valid = start => isBoundary(oldText, start) && isBoundary(oldText, start + removed) &&
      isBoundary(newText, start) && isBoundary(newText, start + inserted);
    while (first <= last && !valid(first)) first += 1;
    while (last >= first && !valid(last)) last -= 1;
    if (first > last) return null;
    const left = { start: first, end: first + removed, inserted };
    return first === last ? [left] : [left, { start: last, end: last + removed, inserted }];
  }

  function mapRange(range, edit, newText) {
    if (range.status === 'unavailable') return unavailable(range);
    const { start: first, end: last, inserted } = edit;
    const delta = inserted - (last - first);
    let start = range.start;
    let end = range.end;
    if (first === last) {
      // An insertion on a saved sentence edge might belong to either neighbor.
      // Do not quietly absorb it into a sentence or claim that sentence is intact.
      if (first === start || first === end) return unavailable(range);
      if (first < start) {
        start += delta;
        end += delta;
      } else if (first < end) end += delta;
    } else if (last <= start) {
      start += delta;
      end += delta;
    } else if (first >= end) {
      // This sentence is wholly before the replacement.
    } else if (first <= start && last >= end) {
      // An explicit sentence-editor action knows which saved sentence it
      // replaces. Only a validated exact-range hint may preserve that identity;
      // ordinary paste/select-all and empty replacements remain unavailable.
      if (edit.sentenceIndex === range.index && first === start && last === end && inserted > 0) {
        end = start + inserted;
      } else return unavailable(range);
    } else if (first >= start && last <= end) {
      end += delta;
    } else {
      // A replacement crosses this sentence's boundary into another region.
      return unavailable(range);
    }
    if (start >= end || !isBoundary(newText, start) || !isBoundary(newText, end)) return unavailable(range);
    return {
      index: range.index, start, end, original: range.original,
      status: newText.slice(start, end) === range.original ? 'unchanged' : 'edited',
    };
  }

  function update(state, newText, editHint) {
    const meta = metadata.get(state);
    if (!meta || typeof newText !== 'string') {
      throw new TypeError('SentenceMap.update requires a tracker state and new text.');
    }
    let ranges;
    if (newText === meta.baseline.text) {
      ranges = copyRanges(meta.baseline.ranges);
    } else if (newText === state.text) {
      ranges = copyRanges(state.ranges);
    } else {
      const hinted = hintedEdit(state.text, newText, editHint);
      // A proven edit location takes precedence over text-only history: deleting
      // different duplicate sentences can produce identical strings but retain
      // different saved sentence identities. Only an explicit undo/redo intent
      // may restore a text snapshot; ordinary unhinted edits stay conservative.
      const historyIntent = editHint && (editHint.inputType === 'historyUndo' || editHint.inputType === 'historyRedo');
      const restored = !hinted && historyIntent && [...meta.snapshots].reverse().find(snapshot => snapshot.text === newText);
      if (restored) {
        // Native undo/redo can restore a state whose ranges were invalidated by
        // a later cross-sentence edit. Exact text snapshots recover that state.
        ranges = copyRanges(restored.ranges);
      } else {
        const edits = hinted || inferredEdits(state.text, newText);
        ranges = state.ranges.map(range => {
          if (!edits) return unavailable(range);
          const mapped = edits.map(edit => mapRange(range, edit, newText));
          const first = mapped[0];
          return mapped.every(item => item.start === first.start && item.end === first.end && item.status === first.status)
            ? first : unavailable(range);
        });
      }
    }
    const previousSnapshot = meta.snapshots.find(item => item.text === newText);
    // Identical text can represent different duplicate-sentence identities in
    // separate editing paths. Future undo/redo must only restore their common
    // safe ranges, while this known current edit retains its precise mapping.
    const snapshot = { text: newText, ranges: previousSnapshot
      ? sharedRanges(previousSnapshot.ranges, ranges) : copyRanges(ranges) };
    const snapshots = [...meta.snapshots.filter(item => item.text !== newText), snapshot].slice(-SNAPSHOT_LIMIT);
    return makeState(newText, ranges, { baseline: meta.baseline, snapshots });
  }

  function locate(state, index) {
    if (!metadata.has(state) || !Number.isSafeInteger(index)) return null;
    const range = state.ranges.find(item => item.index === index);
    return range && range.status !== 'unavailable' ? { ...range } : null;
  }

  global.SentenceMap = Object.freeze({ create, update, locate });
})(typeof window === 'object' ? window : globalThis);

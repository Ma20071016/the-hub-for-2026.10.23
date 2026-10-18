(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DraftStore = api;
}(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  const PREFIX = 'cmit:workspace-draft:v1:';
  const REVIEW_ID = /^[a-f0-9]{32}$/;
  const STATES = new Set(['unreviewed', 'confirmed', 'dismissed', 'pending']);
  const SNAPSHOT_FIELDS = ['schema_version', 'saved_at', 'review_id', 'title', 'text', 'source_id',
    'record_text', 'decisions_revision', 'base_decisions', 'decisions', 'sentence_edit'];

  function hasFields(value, fields) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === fields.length
      && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
  }

  function boundedString(value, maximum) {
    if (typeof value !== 'string') return false;
    let length = 0;
    for (const character of value) {
      length += 1;
      if (length > maximum) return false;
    }
    return true;
  }

  function validReviewId(value) {
    return value === null || (typeof value === 'string' && REVIEW_ID.test(value));
  }

  function nonnegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }

  function validDecisions(value) {
    return Array.isArray(value) && value.length <= 5000
      && Array.from({ length: value.length }, (_, index) => index).every((index) => {
        const decision = value[index];
        return hasFields(decision, ['index', 'state', 'note']) && decision.index === index
          && STATES.has(decision.state) && boundedString(decision.note, 2000);
      });
  }

  // Copy only the declared schema, so callers cannot mutate a returned draft through their input.
  function validateSnapshot(value) {
    if (!hasFields(value, SNAPSHOT_FIELDS) || value.schema_version !== 1
      || !validTimestamp(value.saved_at) || !validReviewId(value.review_id)
      || !boundedString(value.title, 120) || !boundedString(value.text, 50000)
      || !(value.source_id === null || (Number.isSafeInteger(value.source_id) && value.source_id > 0))
      || !validDecisions(value.base_decisions) || !validDecisions(value.decisions)
      || value.base_decisions.length !== value.decisions.length) return null;

    if (value.review_id === null) {
      if (value.record_text !== null || value.decisions_revision !== null
        || value.base_decisions.length !== 0 || value.sentence_edit !== null) return null;
    } else if (!boundedString(value.record_text, 50000) || !nonnegativeInteger(value.decisions_revision)) {
      return null;
    }

    const edit = value.sentence_edit;
    if (edit !== null && (!hasFields(edit, ['index', 'base', 'text', 'conflict'])
      || !nonnegativeInteger(edit.index) || edit.index >= value.decisions.length
      || !boundedString(edit.base, 50000) || !boundedString(edit.text, 50000)
      || typeof edit.conflict !== 'boolean')) return null;

    const copyDecisions = (decisions) => decisions.map(({ index, state, note }) => ({ index, state, note }));
    return {
      schema_version: 1,
      saved_at: value.saved_at,
      review_id: value.review_id,
      title: value.title,
      text: value.text,
      source_id: value.source_id,
      record_text: value.record_text,
      decisions_revision: value.decisions_revision,
      base_decisions: copyDecisions(value.base_decisions),
      decisions: copyDecisions(value.decisions),
      sentence_edit: edit === null ? null : { index: edit.index, base: edit.base, text: edit.text, conflict: edit.conflict },
    };
  }

  function keyFor(reviewId) {
    return PREFIX + (reviewId === null ? 'new' : `review:${reviewId}`);
  }

  function failure(reason, raw = null) {
    return { ok: false, reason, raw };
  }

  function create(getStorage) {
    function storage() {
      const value = typeof getStorage === 'function' ? getStorage() : null;
      if (!value || typeof value.getItem !== 'function' || typeof value.setItem !== 'function'
        || typeof value.removeItem !== 'function') throw new Error('Draft storage is unavailable.');
      return value;
    }

    function read(reviewId = null) {
      if (!validReviewId(reviewId)) return failure('invalid');
      let raw = null;
      try {
        raw = storage().getItem(keyFor(reviewId));
      } catch (error) {
        return failure('unavailable');
      }
      if (raw === null) return { ok: true, draft: null, raw: null };
      if (typeof raw !== 'string') return failure('invalid');
      try {
        const draft = validateSnapshot(JSON.parse(raw));
        if (!draft || draft.review_id !== reviewId) return failure('invalid', raw);
        return { ok: true, draft, raw };
      } catch (error) {
        return failure('invalid', raw);
      }
    }

    function write(snapshot, expectedRaw = null) {
      if (!(expectedRaw === null || typeof expectedRaw === 'string')) return failure('invalid');
      let draft;
      try {
        draft = validateSnapshot(snapshot);
      } catch (error) {
        return failure('invalid');
      }
      if (!draft) return failure('invalid');
      let currentRaw = null;
      try {
        const target = storage();
        const key = keyFor(draft.review_id);
        currentRaw = target.getItem(key);
        // The raw value acts as a revision token. A stale tab must ask the user before replacing it.
        if (currentRaw !== expectedRaw) return failure('conflict', currentRaw);
        const raw = JSON.stringify(draft);
        target.setItem(key, raw);
        return { ok: true, draft, raw };
      } catch (error) {
        return failure('unavailable', currentRaw);
      }
    }

    function remove(reviewId = null, expectedRaw = null) {
      if (!validReviewId(reviewId) || !(expectedRaw === null || typeof expectedRaw === 'string')) return failure('invalid');
      let currentRaw = null;
      try {
        const target = storage();
        const key = keyFor(reviewId);
        currentRaw = target.getItem(key);
        if (currentRaw !== expectedRaw) return failure('conflict', currentRaw);
        target.removeItem(key);
        return { ok: true, draft: null, raw: null };
      } catch (error) {
        return failure('unavailable', currentRaw);
      }
    }

    return { read, write, remove };
  }

  return { create };
}));

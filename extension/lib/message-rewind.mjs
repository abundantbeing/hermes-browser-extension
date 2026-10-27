// Pure truncation/rewind planning for editing and restoring a user turn.
// Adapted from Hermes Desktop's rewind.ts: row id or nothing, never an ordinal.
// The gateway stores the full prompt (display text plus injected browser
// context), so matching is done on the display text via an injected stripper.

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function durableUserRows(history) {
  return asList(history).filter(
    (row) => row && row.role === 'user' && !row.display_kind && Number.isInteger(row.row_id),
  );
}

// The gateway truncation contract. Fail closed: no address, no truncation.
export function truncateSubmitParams({ rowId } = {}) {
  if (!Number.isInteger(rowId) || rowId <= 0) return {};
  return {
    confirm_truncate: true,
    truncate_before_row_id: rowId,
    confirm_empty_truncate: true,
  };
}

const TRUNCATE_KEYS = Object.freeze(['confirm_truncate', 'truncate_before_row_id', 'confirm_empty_truncate']);

// A gateway that refuses prompt.submit because of the truncate keys (a session
// authority's canonical submit has a closed key set). That refusal says nothing
// about display_text, so it must never mark that quirk: the keys that were
// refused are not removable by retrying without cosmetics.
export function isTruncateRejection(error) {
  const fields = error?.data?.fields;
  if (Array.isArray(fields) && fields.some((field) => TRUNCATE_KEYS.some((key) => String(field) === key || String(field).startsWith(`${key}.`)))) {
    return true;
  }
  const text = String(error?.message || error || '');
  return /invalid params for prompt\.submit/i.test(text) && TRUNCATE_KEYS.some((key) => text.includes(key));
}

export function resolveRowIdByDisplayText(history, text, { displayText, isNewest = false } = {}) {
  const wanted = String(text ?? '').trim();
  if (!wanted) return undefined;
  const strip = typeof displayText === 'function' ? displayText : (_role, content) => content;
  const durable = durableUserRows(history);
  const matches = durable.filter((row) => String(strip('user', row.content) ?? '').trim() === wanted);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0].row_id;
  // Duplicate display text is ambiguous. Only the newest-at-the-tail case is
  // safe to resolve, and only when the last match is the last durable user row.
  if (isNewest) {
    const last = durable[durable.length - 1];
    const lastMatch = matches[matches.length - 1];
    if (last && lastMatch && last.row_id === lastMatch.row_id) return lastMatch.row_id;
  }
  return undefined;
}

export function planEdit(records, index, newText) {
  const source = asList(records)[index];
  if (!source || source.role !== 'user') return null;
  const text = String(newText ?? '').trim();
  if (!text) return null;
  const sourceText = String(source.content ?? '');
  if (text === sourceText.trim()) return null;
  return {
    sourceIndex: index,
    sourceText,
    text,
    rowId: Number.isInteger(source.rowId) ? source.rowId : undefined,
  };
}

export function planRestore(records, index) {
  const source = asList(records)[index];
  if (!source || source.role !== 'user') {
    throw new Error('Restore requires an existing user message.');
  }
  const sourceText = String(source.content ?? '');
  return {
    sourceIndex: index,
    sourceText,
    text: sourceText,
    rowId: Number.isInteger(source.rowId) ? source.rowId : undefined,
  };
}

// Pure: returns a new array (prefix + the source record rewritten), input intact.
export function applyRewindLocally(records, sourceIndex, editedText, { now = Date.now() } = {}) {
  const list = asList(records);
  const index = Number.isInteger(sourceIndex) ? sourceIndex : list.length;
  const prefix = list.slice(0, Math.max(0, index));
  const source = list[index];
  if (!source) return prefix;
  const next = {
    ...source,
    ...(editedText !== undefined ? { content: String(editedText) } : {}),
    ts: now,
    rowId: undefined,
  };
  return [...prefix, next];
}

function withoutRowId(record) {
  const copy = { ...record };
  delete copy.rowId;
  return copy;
}

export function rebindSurvivorRowIds(records, result = {}) {
  const list = asList(records);
  const map = result?.survivor_row_id_map;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    return list.map((record) => {
      const copy = record && typeof record === 'object' ? { ...record } : record;
      if (!record || !Number.isInteger(record.rowId)) return copy;
      const key = String(record.rowId);
      if (!Object.prototype.hasOwnProperty.call(map, key)) return copy;
      const next = map[key];
      return Number.isInteger(next) && next > 0 ? { ...record, rowId: next } : withoutRowId(record);
    });
  }
  const ids = result?.survivor_user_row_ids;
  if (Array.isArray(ids)) {
    let cursor = 0;
    return list.map((record) => {
      const copy = record && typeof record === 'object' ? { ...record } : record;
      if (!record || record.role !== 'user' || !Number.isInteger(record.rowId)) return copy;
      if (cursor >= ids.length) return copy;
      const next = ids[cursor];
      cursor += 1;
      return Number.isInteger(next) && next > 0 ? { ...record, rowId: next } : withoutRowId(record);
    });
  }
  return list.map((record) => (record && typeof record === 'object' ? { ...record } : record));
}

// Walk both lists in order; bind a record only when its display text matches
// exactly one durable user row (fail closed on duplicates).
export function bindRowIdsFromHistory(records, history, { displayText } = {}) {
  const strip = typeof displayText === 'function' ? displayText : (_role, content) => content;
  const durable = durableUserRows(history);
  const used = new Set(asList(records).filter((record) => Number.isInteger(record?.rowId)).map((record) => record.rowId));
  return asList(records).map((record) => {
    if (!record || record.role !== 'user' || Number.isInteger(record.rowId)) return record;
    const text = String(strip('user', record.content) ?? '').trim();
    if (!text) return record;
    const matches = durable.filter((row) => String(strip('user', row.content) ?? '').trim() === text);
    if (matches.length !== 1) return record;
    const rowId = matches[0].row_id;
    if (used.has(rowId)) return record;
    used.add(rowId);
    return { ...record, rowId };
  });
}
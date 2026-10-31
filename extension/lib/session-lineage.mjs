// Compression lineage on a LEGACY dashboard socket.
//
// Contract (installed Hermes, read only):
//   * tui_gateway/session_compression.py `_sync_session_key_after_compress`: when a compression
//     rotates `agent.session_id`, the live runtime's `session_key` moves to the successor. The live
//     runtime id (`session_id`, what this socket addresses) does not change.
//   * tui_gateway/methods_session.py `session.compress` returns `info` (SessionLiveInfo) whose
//     `stored_session_id` is the successor, and emits `session.info` with the same.
//   * tui_gateway/session_registry.py `_session_live_item`: `session.active_list` reports
//     `id` = the live runtime id and `session_key` = the CURRENT key (`_session_lookup_key`), so after
//     a rotation (manual or automatic) the row's key no longer equals the id the panel stored.
//
// A SESSION AUTHORITY never rotates the durable key. gateway/session_active_list.py reports `id` and
// `session_key` as the same session id, and `session.mutate operation=compress` keeps the session id
// (a rotating compaction moves the physical target only: `target_session_id` /
// `previous_target_session_id`, see session-compact.mjs). Nothing here applies to it.

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * The successor durable id a `session.compress` result names, or '' when the key did not change.
 */
export function compressionSuccessor(result, currentId = '') {
  const payload = result && typeof result === 'object' ? result : {};
  const next = clean(payload.info?.stored_session_id || payload.stored_session_id || payload.rotated_session_id);
  const current = clean(currentId);
  return next && next !== current ? next : '';
}

/**
 * The successor a `session.active_list` payload reveals for the session this socket has open: the
 * row for the live runtime id whose `session_key` is not the durable id the panel holds. Never on a
 * session authority, whose keys do not rotate (and whose id and key are the same value).
 */
export function rosterSuccessor(payload, { liveId = '', storedId = '', authority = false } = {}) {
  if (authority) return '';
  const live = clean(liveId);
  const stored = clean(storedId);
  if (!live || !stored) return '';
  const rows = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const row = rows.find((candidate) => clean(candidate?.id) === live);
  const key = clean(row?.session_key);
  return key && key !== stored ? key : '';
}

/**
 * Parent -> successor, followed to the tip. Bounded, and a cycle can never loop.
 */
export function createSessionLineage({ max = 64 } = {}) {
  const successors = new Map();
  return {
    adopt(parentId, childId) {
      const parent = clean(parentId);
      const child = clean(childId);
      if (!parent || !child || parent === child) return false;
      // A successor that already leads back to the parent would close a loop.
      let cursor = child;
      for (let hops = 0; hops < max && cursor; hops += 1) {
        if (cursor === parent) return false;
        cursor = successors.get(cursor) || '';
      }
      successors.delete(parent);
      successors.set(parent, child);
      while (successors.size > max) successors.delete(successors.keys().next().value);
      return true;
    },
    resolve(id) {
      let current = clean(id);
      const seen = new Set();
      while (current && successors.has(current) && !seen.has(current)) {
        seen.add(current);
        current = successors.get(current);
      }
      return current;
    },
    get size() {
      return successors.size;
    },
  };
}

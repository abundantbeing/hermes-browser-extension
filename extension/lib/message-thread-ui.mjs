// Shared side-panel/full-view thread behavior. The caller owns transcript data.
import { buildDayDivider, buildMessageRail, setRailCopyEnabled, setReadAloudState } from './message-actions.mjs';
import { dayDividerLabel, decideRailPlacement, normalizeMessageTimestamp } from './message-meta.mjs';

export function createMessageThreadUi({
  root, document = globalThis.document, window = globalThis.window,
  ResizeObserver = globalThis.ResizeObserver,
  requestFrame = (callback) => (globalThis.requestAnimationFrame || ((fn) => fn()))(callback),
  locale = () => undefined, translate = (text) => text, now = () => Date.now(),
  canRewind = () => false, replyLabelFor = () => '', durationLabelFor = () => '',
  canReadAloud = () => false, readAloudStateFor = () => 'idle',
  onCopy, onEdit, onRestore, onReply, onReadAloud, onDayDivider,
} = {}) {
  let pinnedRow = null;
  let previousTs = null;
  let previous = null;
  const rows = new Map();

  function pin(row) {
    if (pinnedRow) pinnedRow.classList.remove('is-pinned');
    pinnedRow = row || null;
    pinnedRow?.classList.add('is-pinned');
  }
  function applyPlacement(row) {
    const bubble = row?.querySelector(':scope > .message');
    const rail = row?.querySelector(':scope > .message-rail');
    if (!bubble || !rail) return;
    const next = row.dataset.role !== 'user' ? 'below' : decideRailPlacement({
      rowWidth: row.clientWidth,
      bubbleWidth: bubble.offsetWidth,
      railWidth: rail.scrollWidth,
      previous: row.dataset.actions || 'below',
    });
    if (next !== row.dataset.actions) row.dataset.actions = next;
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    for (const entry of entries) applyPlacement(entry.target.closest?.('.message-row') || entry.target);
  }) : null;

  function renderRail(entry) {
    const { row, node, record, room, streaming } = entry;
    row.querySelector(':scope > .message-rail')?.remove();
    row.classList.remove('is-being-read');
    if (!['user', 'assistant'].includes(record.role)) return;
    const rewind = !room && canRewind(record);
    const readAloudState = readAloudStateFor(record);
    const readAloudActive = readAloudState === 'speaking' || readAloudState === 'loading';
    const rail = buildMessageRail({
      document, role: record.role, ts: normalizeMessageTimestamp(record.ts, { now: now() }),
      now: now(), locale: locale(), translate,
      // A reply's time is when it finished, so it joins the rail once the
      // stream ends; the rail keeps its height either way, so nothing jumps.
      showTime: !streaming,
      canEdit: rewind, canRestore: rewind,
      replyLabel: room && record.role === 'assistant' ? replyLabelFor(record) : '',
      durationLabel: !streaming && record.role === 'assistant' ? durationLabelFor(record) : '',
      canReadAloud: record.role === 'assistant' && !streaming && (canReadAloud(record, node) || readAloudActive),
      readAloudState,
      onReply: () => onReply?.(record, node),
      onReadAloud: () => onReadAloud?.(record, node),
      onCopy: () => onCopy?.(record, node),
      onEdit: () => onEdit?.(row, record),
      onRestore: (event) => onRestore?.(row, record, event.currentTarget),
    });
    setRailCopyEnabled(rail, !streaming);
    row.append(rail);
    setReadAloudState(rail, readAloudState, { translate });
    requestFrame(() => applyPlacement(row));
  }

  function attach({ row, node, record, room = false, streaming = false, entering = false, divider = true } = {}) {
    row.dataset.role = record.role;
    row.dataset.actions = 'below';
    node.setAttribute('tabindex', '0');
    const ts = normalizeMessageTimestamp(record.ts, { now: now() });
    const label = divider ? dayDividerLabel(ts, previousTs, { now: now(), locale: locale(), translate }) : '';
    if (label) {
      const handled = onDayDivider?.({ label, record, row });
      if (!handled) root.append(buildDayDivider({ document, label }));
    }
    if (Number.isFinite(ts)) previousTs = ts;
    const continues = !label && previous?.row?.isConnected
      && previous.record.role === record.role
      && String(previous.record.speaker || '') === String(record.speaker || '')
      && String(previous.record.thread || '') === String(record.thread || '');
    if (continues) {
      row.classList.add('is-run-continuation');
      previous.row.classList.add('has-run-next');
    } else {
      row.classList.add('is-run-start');
    }
    if (entering) {
      row.classList.add('is-entering');
      row.addEventListener('animationend', () => row.classList.remove('is-entering'), { once: true });
    }
    const entry = { row, node, record, room, streaming };
    rows.set(row, entry);
    previous = entry;
    renderRail(entry);
    observer?.observe(row);
    observer?.observe(node);
    return row;
  }

  function clickMessage(event) {
    if (event.target?.closest?.('.message-rail, a, button, summary, input, textarea, .message-editor, .message-restore-popover')) return;
    const row = event.target?.closest?.('.message-row');
    if (!row || !root.contains(row)) return;
    const selection = window?.getSelection?.();
    if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return;
    pin(pinnedRow === row ? null : row);
  }
  function clickOutside(event) {
    if (pinnedRow && !pinnedRow.contains(event.target)) pin(null);
  }
  function escape(event) {
    if (event.key === 'Escape') pin(null);
  }
  root.addEventListener('click', clickMessage);
  document.addEventListener('click', clickOutside);
  document.addEventListener('keydown', escape);

  function reset() {
    observer?.disconnect();
    pin(null);
    previousTs = null;
    previous = null;
    rows.clear();
  }
  function refreshActions() {
    const focused = document.activeElement;
    const focusedRow = focused?.closest?.('.message-row');
    const restoreSpeakFocus = Boolean(
      focused?.classList?.contains?.('message-action-speak')
        && focusedRow
        && root.contains(focusedRow),
    );
    for (const [row, entry] of rows) {
      if (!root.contains(row)) {
        observer?.unobserve?.(row);
        observer?.unobserve?.(entry.node);
        rows.delete(row);
      } else {
        renderRail(entry);
      }
    }
    if (restoreSpeakFocus) {
      focusedRow.querySelector(':scope > .message-rail .message-action-speak')?.focus?.();
    }
  }
  function readAloudRailsNeedRebuild() {
    for (const [row, entry] of rows) {
      if (!root.contains(row) || entry.streaming || entry.record.role !== 'assistant') continue;
      const speakBtn = row.querySelector(':scope > .message-rail .message-action-speak');
      const state = readAloudStateFor(entry.record);
      const activePlayback = state === 'speaking' || state === 'loading';
      const shouldShowSpeak = canReadAloud(entry.record, entry.node) || activePlayback;
      if (shouldShowSpeak !== Boolean(speakBtn)) return true;
    }
    return false;
  }
  // After the dashboard voice probe: rebuild when rails are stale (missing speaker or
  // speaker when read-aloud is off); otherwise update pressed/Stop state in place so keyboard focus is kept.
  function refreshAfterReadAloudProbe() {
    if (readAloudRailsNeedRebuild()) refreshActions();
    else refreshReadAloud();
  }
  function setStreaming(row, streaming) {
    const entry = rows.get(row);
    if (!entry) return;
    const finished = entry.streaming && !streaming;
    entry.streaming = Boolean(streaming);
    if (!finished) {
      setRailCopyEnabled(row.querySelector(':scope > .message-rail'), !entry.streaming);
      return;
    }
    // A live reply has no stored time yet: it finished now.
    if (normalizeMessageTimestamp(entry.record.ts, { now: now() }) === null) entry.record.ts = now();
    renderRail(entry);
  }
  // Only the speaker buttons and the reply being read change: no rail is rebuilt.
  function refreshReadAloud() {
    for (const [row, entry] of rows) {
      if (!root.contains(row)) continue;
      setReadAloudState(row.querySelector(':scope > .message-rail'), readAloudStateFor(entry.record), { translate });
    }
  }
  function dispose() {
    reset();
    root.removeEventListener('click', clickMessage);
    document.removeEventListener('click', clickOutside);
    document.removeEventListener('keydown', escape);
  }
  return {
    attach, applyPlacement, reset, refreshActions, refreshReadAloud, refreshAfterReadAloudProbe,
    readAloudRailsNeedRebuild, setStreaming, pin, dispose,
  };
}

import { REST_TURN_SOURCES, isHermesBrowserOwnedSession } from './common.mjs';
import { BOT_CHAT_TITLE } from './bot-canonical-session.mjs';

// Chats saved by older extension builds carry `source: hermes_browser`. Current
// Hermes admits a REST/SSE turn only for sessions stored as api_server or
// bot_room and refuses the rest with `permission_denied`. The old repair, a
// PATCH that relabels the session, is refused too on a gateway that validates
// session fields strictly, so the turn has no way through.
//
// A fork is such a gateway's own answer: POST /api/sessions/{id}/fork copies the
// transcript into a new session stored as api_server. This module decides when
// a refusal is that case, and runs "Continue in a copy": fork, open the copy,
// resend the message once, and remember old -> copy so the old chat opens the
// copy from then on.

export const SOURCE_REFUSAL_CODE = 'permission_denied';
export const LEGACY_FORKS_STORAGE_KEY = 'hermesLegacySessionForks';
export const LEGACY_FORKS_MAX = 200;

// Stock answers the refusal as the bare reason code: an SSE `error` event whose
// message is `permission_denied`, or an HTTP error whose body carries it (which
// the request error wraps as "Hermes stream failed (409): permission_denied").
// Prose such as "Permission denied: tool x" is a different refusal and never
// matches.
const REFUSAL_MESSAGE = /^(?:[^:\n]{0,80}\(\d{3}\):\s*)?permission_denied\.?$/i;

export function isSessionSourceRefusal(error) {
  if (!error) return false;
  const codes = [error.code, error.errorCode, error.payload?.error?.code, error.payload?.code, error.errorSurface?.code];
  if (codes.some((code) => String(code ?? '').trim().toLowerCase() === SOURCE_REFUSAL_CODE)) return true;
  const message = String(error?.message ?? (typeof error === 'string' ? error : '')).replace(/\s+/g, ' ').trim();
  return REFUSAL_MESSAGE.test(message);
}

export function sessionRowOf(payload) {
  const row = payload?.session && typeof payload.session === 'object' ? payload.session : payload;
  return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
}

// The stored source when it is one the turn gate refuses; '' for a source it
// admits or one that cannot be read (then the refusal is some other one).
// Only a chat this browser owns (stored as hermes_browser, or under the extension's own id) is
// the older-build case. A bot's Bot Chat keeps its source on purpose and is handed to its own
// lane, so it is never forked, and another surface's chat is not this browser's to copy.
export function legacySessionSource(payload) {
  const row = sessionRowOf(payload);
  const source = String(row?.source || '').trim().toLowerCase();
  if (!source || REST_TURN_SOURCES.includes(source)) return '';
  if (String(row?.root_title || row?.title || '').trim() === BOT_CHAT_TITLE) return '';
  if (!isHermesBrowserOwnedSession({ id: row?.id, source })) return '';
  return source;
}

// What to offer after a `permission_denied` turn, from the session row read back
// after the refusal. A refusal on a session the gate admits (or that cannot be
// read) is not this problem and gets no offer, so unrelated permission errors
// are never forked.
export function planSourceRefusalRecovery({ session = null, forkAdvertised = false } = {}) {
  const source = legacySessionSource(session);
  if (!source) return { kind: 'unrelated', source: '' };
  return { kind: forkAdvertised ? 'fork' : 'new-chat', source };
}

function isUnsupportedStatus(status) {
  return [404, 405, 501].includes(Number(status));
}

// Fork the session, open the copy and resend the message there once.
//   fetchJson(path, init) -> { ok, status, payload }   (may throw on a network failure)
//   openCopy(row)         -> truthy when the copy is open
//   resend(copyId)        -> the send's own result; called at most once
//   remember(oldId, copy) -> persists the old -> copy mapping
// A fork that fails, or a copy that will not open, stops before any resend.
export async function continueInSessionCopy({
  sessionId,
  fetchJson,
  openCopy,
  resend,
  remember = async () => {},
  makeCopyId = () => '',
  encodeId = encodeURIComponent,
} = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, stage: 'fork', reason: 'no-session' };
  const requestedCopyId = String(makeCopyId() || '').trim();
  let forked;
  try {
    forked = await fetchJson(`/api/sessions/${encodeId(id)}/fork`, {
      method: 'POST',
      body: JSON.stringify(requestedCopyId ? { id: requestedCopyId } : {}),
    });
  } catch (error) {
    return { ok: false, stage: 'fork', reason: 'fork-failed', error };
  }
  if (!forked?.ok) {
    return {
      ok: false,
      stage: 'fork',
      reason: isUnsupportedStatus(forked?.status) ? 'fork-unsupported' : 'fork-failed',
      status: Number(forked?.status) || 0,
    };
  }
  const row = sessionRowOf(forked.payload);
  const copyId = String(row?.id || requestedCopyId || '').trim();
  if (!copyId) return { ok: false, stage: 'fork', reason: 'fork-failed', status: Number(forked.status) || 0 };
  const copy = { ...row, id: copyId };
  try {
    await remember(id, copy);
  } catch {
    // The mapping is a convenience; the copy still works without it.
  }
  let opened = false;
  try {
    opened = Boolean(await openCopy(copy));
  } catch {
    opened = false;
  }
  if (!opened) return { ok: false, stage: 'open', reason: 'open-failed', copyId };
  const resent = await resend(copyId);
  return { ok: true, copyId, resent: resent !== false };
}

// old session id -> { id, title, at } for the copies this browser made.
export function normalizeLegacyForks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [from, value] of Object.entries(raw)) {
    const to = String(value?.id || '').trim();
    if (!from || !to || from === to) continue;
    out[from] = { id: to, title: String(value?.title || '').slice(0, 200), at: Number(value?.at) || 0 };
  }
  return out;
}

export function withLegacyFork(map, fromId, copy, now = Date.now()) {
  const next = normalizeLegacyForks(map);
  const from = String(fromId || '').trim();
  const to = String(copy?.id || '').trim();
  if (!from || !to || from === to) return next;
  next[from] = { id: to, title: String(copy?.title || '').slice(0, 200), at: now };
  const entries = Object.entries(next).sort((a, b) => b[1].at - a[1].at).slice(0, LEGACY_FORKS_MAX);
  return Object.fromEntries(entries);
}

// Follow old -> copy (a copy can itself be forked later); a cycle or a long
// chain stops where it is.
export function resolveLegacyFork(map, sessionId) {
  const forks = normalizeLegacyForks(map);
  const seen = new Set();
  let current = String(sessionId || '').trim();
  let hit = null;
  for (let hop = 0; hop < 8 && current && forks[current] && !seen.has(current); hop += 1) {
    seen.add(current);
    hit = forks[current];
    current = hit.id;
  }
  return hit ? { id: hit.id, title: hit.title } : null;
}

export async function readLegacyForks(storageArea = null) {
  try {
    const stored = await storageArea?.get?.(LEGACY_FORKS_STORAGE_KEY);
    return normalizeLegacyForks(stored?.[LEGACY_FORKS_STORAGE_KEY]);
  } catch {
    return {};
  }
}

export async function rememberLegacyFork(storageArea, fromId, copy, now = Date.now()) {
  const next = withLegacyFork(await readLegacyForks(storageArea), fromId, copy, now);
  await storageArea?.set?.({ [LEGACY_FORKS_STORAGE_KEY]: next });
  return next;
}

// A small button row for a chat bubble. Each action runs at most once at a time
// (all buttons lock while one runs) and unlocks again if it reports failure by
// returning false.
export function createSessionRecoveryActions({ document: doc = globalThis.document, actions = [] } = {}) {
  const root = doc.createElement('div');
  root.className = 'session-recovery-actions';
  const buttons = [];
  const lock = (locked) => { for (const button of buttons) button.disabled = locked; };
  for (const action of actions) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `secondary tiny session-recovery-${action.id || 'action'}`;
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      lock(true);
      const idleLabel = button.textContent;
      if (action.busyLabel) button.textContent = action.busyLabel;
      let keep = false;
      try {
        keep = (await action.run()) === false;
      } catch {
        keep = true;
      }
      button.textContent = idleLabel;
      if (keep) lock(false);
      else root.hidden = true;
    });
    buttons.push(button);
    root.append(button);
  }
  return root;
}

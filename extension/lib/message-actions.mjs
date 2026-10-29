// DOM builder for the per-message action rail (time, restore, edit, copy) and
// the day divider. All environment access is injected so it runs under linkedom.
import { formatMessageTime, formatMessageTimeFull, normalizeMessageTimestamp } from './message-meta.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RESET_MS = 1600;
// 24x24 viewBox, 1.6 stroke, round caps. Simple, consistent geometry.
const ICONS = {
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  restore: ['M4 12a8 8 0 1 0 2.4-5.7', 'M4 4v5h5'],
  reply: ['M10 6L4 12l6 6', 'M4 12h10a6 6 0 0 1 6 6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
};

function icon(document, name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('message-action-icon');
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function actionButton(document, { kind, label, translate, onClick }) {
  const button = document.createElement('button');
  button.setAttribute('type', 'button');
  button.type = 'button';
  button.className = `message-action message-action-${kind}`;
  const text = translate(label);
  button.setAttribute('aria-label', text);
  button.setAttribute('title', text);
  button.title = text;
  button.append(icon(document, kind));
  button.addEventListener('click', (event) => {
    event?.stopPropagation?.(); // never toggles the bubble pin
    onClick?.(event);
  });
  return button;
}

export function buildMessageRail({
  document, role, ts = null, now = Date.now(), locale, translate = (s) => s,
  showTime = true, canEdit = false, canRestore = false,
  replyLabel = '', durationLabel = '', onCopy, onEdit, onRestore, onReply,
} = {}) {
  const rail = document.createElement('div');
  rail.className = 'message-rail';
  rail.dataset.role = role;
  const isUser = role === 'user';

  const timestamp = normalizeMessageTimestamp(ts, { now });
  const date = timestamp === null ? null : new Date(timestamp);
  if (showTime && date && Number.isFinite(date.getTime())) {
    const iso = date.toISOString();
    const time = document.createElement('time');
    time.className = 'message-time';
    time.setAttribute('datetime', iso);
    time.dateTime = iso;
    const full = formatMessageTimeFull(timestamp, { locale });
    time.setAttribute('title', full);
    time.title = full;
    time.textContent = formatMessageTime(timestamp, { now, locale });
    rail.append(time);
  }
  // How long the turn this reply ends took ("14s"), beside its time.
  if (durationLabel) {
    const duration = document.createElement('span');
    duration.className = 'message-duration';
    duration.textContent = durationLabel;
    rail.append(duration);
  }
  if (isUser && canRestore) {
    rail.append(actionButton(document, { kind: 'restore', label: 'Restore checkpoint: rerun from this prompt', translate, onClick: onRestore }));
  }
  if (isUser && canEdit) {
    rail.append(actionButton(document, { kind: 'edit', label: 'Edit message', translate, onClick: onEdit }));
  }

  // Room replies only: the caller passes the already-translated "Reply to @name".
  if (replyLabel && typeof onReply === 'function') {
    rail.append(actionButton(document, { kind: 'reply', label: replyLabel, translate: (text) => text, onClick: onReply }));
  }

  const copy = actionButton(document, { kind: 'copy', label: 'Copy message', translate, onClick: null });
  let timer = 0;
  let generation = 0;
  copy.addEventListener('click', async () => {
    if (copy.disabled) return;
    const gen = (generation += 1);
    let ok = false;
    try {
      ok = (await Promise.resolve(onCopy?.())) === true;
    } catch {
      ok = false;
    }
    // A newer click superseded this one while it awaited: drop the stale result
    // so a slow failure can never overwrite a newer success (and vice versa).
    if (gen !== generation) return;
    copy.classList.remove('is-copied', 'is-copy-failed');
    copy.classList.add(ok ? 'is-copied' : 'is-copy-failed');
    const state = translate(ok ? 'Copied' : 'Copy failed');
    copy.setAttribute('aria-label', state);
    copy.setAttribute('title', state);
    copy.title = state;
    const glyph = copy.querySelector('svg');
    if (ok && glyph) glyph.replaceWith(icon(document, 'check'));
    clearTimeout(timer);
    timer = setTimeout(() => {
      copy.classList.remove('is-copied', 'is-copy-failed');
      const base = translate('Copy message');
      copy.setAttribute('aria-label', base);
      copy.setAttribute('title', base);
      copy.title = base;
      const current = copy.querySelector('svg');
      if (current) current.replaceWith(icon(document, 'copy'));
    }, RESET_MS);
  });
  rail.append(copy);
  return rail;
}

export function setRailCopyEnabled(rail, enabled) {
  const copy = rail?.querySelector?.('.message-action-copy');
  if (copy) copy.disabled = !enabled;
}

export function buildDayDivider({ document, label }) {
  const divider = document.createElement('div');
  divider.className = 'message-day-divider';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', label);
  const span = document.createElement('span');
  span.className = 'message-day-divider-label';
  span.textContent = label;
  divider.append(span);
  return divider;
}
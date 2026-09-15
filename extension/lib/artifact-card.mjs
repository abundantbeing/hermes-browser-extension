// File-card DOM for returned files.
//
// One card vocabulary shared by the side panel and the full tab. A returned
// file is a Hermes Browser object, not a chat bubble: a leading type token in
// the mono font sits in a chip tinted by the file's family (document / sheet /
// media / archive / unknown), the name de-emphasises its own extension, a
// single mono meta line carries where the file lives and how big it is, and
// the action row leads with a filled primary tile. The markdown renderer emits
// the same card as a button-less "chip" so an un-hydrated transcript still
// names the file honestly; surfaces enrich that chip once they know whether
// the bytes can actually be read. No global DOM access — every entry point
// takes an explicit document, so this module stays testable in node.

import { artifactActionPlan, artifactKindFamily, extractArtifactPaths } from './artifact-actions.mjs';

export const ARTIFACT_CARD_CLASS = 'artifact-card';
export const ARTIFACT_CARD_CHIP_CLASS = 'artifact-card-pending';
export const ARTIFACT_CARD_REVEAL_ATTRIBUTE = 'data-artifact-reveal';
export const ARTIFACT_CARD_PRIMARY_CLASS = 'artifact-card-action-primary';

const DEFAULT_LABELS = Object.freeze({
  open: 'Open',
  'open-on-computer': 'Open on computer',
  save: 'Save',
  localSource: 'On this computer',
  remoteSource: 'Returned by Hermes',
  checking: 'Checking whether Hermes can read this file…',
  opening: 'Opening…',
  openingOnComputer: 'Opening on this computer…',
  saving: 'Saving…',
});

function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cardLabels(labels = {}) {
  return { ...DEFAULT_LABELS, ...(labels && typeof labels === 'object' ? labels : {}) };
}

/**
 * '312 KB' / '1.2 MB' for a byte count; '' when the size is unknown.
 * @param {unknown} bytes
 * @returns {string}
 */
export function formatArtifactBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const rounded = scaled >= 10 || Number.isInteger(scaled) ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

// 'On this computer · 402 KB' — where the file lives and how big it is, never
// the raw path: the whole path stays one hover away in the title attribute.
function cardSourceLine(plan = {}, size = null, labels = DEFAULT_LABELS) {
  const where = plan.local ? labels.localSource : labels.remoteSource;
  const sizeLabel = formatArtifactBytes(size);
  return [where, sizeLabel].filter(Boolean).join(' · ');
}

// 'quarterly-report' + '.pdf', so the extension can be de-emphasised by size
// and weight while the name element still reads as one string.
export function splitArtifactFileName(name = '', extension = '') {
  const value = String(name || '');
  const suffix = String(extension || '');
  if (!suffix) return { base: value, extension: '' };
  const dotted = `.${suffix}`;
  if (value.toLowerCase().endsWith(dotted.toLowerCase())) {
    return { base: value.slice(0, value.length - dotted.length), extension: value.slice(value.length - dotted.length) };
  }
  return { base: value, extension: '' };
}

function findNote(card) {
  if (!card?.children) return null;
  return [...card.children].find((child) => child.classList?.contains('artifact-card-note')) || null;
}

function cardButtons(card) {
  if (!card?.querySelectorAll) return [];
  return [...card.querySelectorAll('button[data-artifact-action]')];
}

/**
 * Put a status line on the card ('' clears it). Used for the honest failure
 * reason and for in-flight action feedback.
 *
 * @param {object} card Card element built by this module.
 * @param {string} text
 * @returns {object|null} the note element, or null when cleared
 */
export function setArtifactCardNote(card, text = '') {
  if (!card?.ownerDocument) return null;
  const value = String(text || '').trim();
  let note = findNote(card);
  if (!value) {
    note?.remove?.();
    if (card.dataset) delete card.dataset.artifactNote;
    return null;
  }
  if (!note) {
    note = card.ownerDocument.createElement('p');
    note.className = 'artifact-card-note';
    note.setAttribute('role', 'status');
    card.append(note);
  }
  note.textContent = value;
  if (card.dataset) card.dataset.artifactNote = 'true';
  return note;
}

/**
 * Mark the card busy while one of its actions runs, so a second click cannot
 * fire the same download twice.
 *
 * @param {object} card
 * @param {boolean} busy
 * @param {{ note?: string }} [options]
 */
export function setArtifactCardBusy(card, busy = false, { note = '' } = {}) {
  if (!card) return;
  if (card.dataset) card.dataset.artifactBusy = busy ? 'true' : 'false';
  for (const button of cardButtons(card)) {
    if (busy) {
      if (!button.disabled) {
        if (button.dataset) button.dataset.artifactWasEnabled = 'true';
        button.disabled = true;
      }
      continue;
    }
    if (button.dataset?.artifactWasEnabled === 'true' && button.dataset?.artifactBlocked !== 'true') {
      button.disabled = false;
    }
    if (button.dataset) delete button.dataset.artifactWasEnabled;
  }
  if (note) setArtifactCardNote(card, note);
}

/**
 * Build the interactive card for a returned file.
 *
 * Structure (top to bottom): a leading type token, the file name with its
 * extension de-emphasised in place, one mono meta line (where it lives · how
 * big it is) whose title carries the full path, then the action row. The first
 * action of the plan is rendered as the filled primary tile.
 *
 * @param {Document} doc
 * @param {ReturnType<typeof artifactActionPlan>} plan
 * @param {{ labels?: Record<string, string>, handlers?: Record<string, (plan: any) => void>, size?: number|null }} [options]
 * @returns {object} section element
 */
export function buildArtifactFileCard(doc, plan, { labels = {}, handlers = {}, size = null } = {}) {
  const text = cardLabels(labels);
  const card = doc.createElement('section');
  card.className = ARTIFACT_CARD_CLASS;
  card.dataset.artifactPath = plan.source;
  card.dataset.artifactKind = plan.kind;
  card.dataset.artifactFamily = plan.family || artifactKindFamily(plan.kind);
  card.dataset.artifactState = plan.readable === false ? 'unreadable' : plan.readable === true ? 'ready' : 'pending';
  // The card is new to the DOM (a chip just became one, or the hydrator placed
  // it after its paragraph) — mark it so the surface plays the short reveal.
  card.dataset.artifactReveal = 'enter';

  const head = doc.createElement('div');
  head.className = 'artifact-card-head';
  const badge = doc.createElement('span');
  badge.className = 'artifact-card-kind';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = plan.badge;
  const copy = doc.createElement('div');
  copy.className = 'artifact-card-copy';
  const name = doc.createElement('strong');
  name.className = 'artifact-card-name';
  name.textContent = plan.name;
  name.title = plan.source;
  const { base, extension } = splitArtifactFileName(plan.name, plan.extension);
  if (extension) {
    name.textContent = base;
    const tail = doc.createElement('span');
    tail.className = 'artifact-card-name-ext';
    tail.textContent = extension;
    name.append(tail);
  }
  const source = doc.createElement('small');
  source.className = 'artifact-card-source';
  source.textContent = cardSourceLine(plan, size, text);
  source.title = plan.source;
  copy.append(name, source);
  head.append(badge, copy);
  card.append(head);

  const actions = doc.createElement('div');
  actions.className = 'artifact-card-actions';
  const planActions = Array.isArray(plan.actions) ? plan.actions : [];
  for (const [index, action] of planActions.entries()) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = index === 0 ? `artifact-card-action ${ARTIFACT_CARD_PRIMARY_CLASS}` : 'artifact-card-action';
    button.dataset.artifactAction = action.id;
    button.textContent = text[action.id] || action.label;
    if (!action.enabled) {
      button.disabled = true;
      button.dataset.artifactBlocked = 'true';
      button.title = action.reason || plan.notice || '';
      button.setAttribute('aria-disabled', 'true');
    }
    const handler = handlers[action.id];
    if (typeof handler === 'function') button.addEventListener('click', () => handler(plan, card));
    actions.append(button);
  }
  card.append(actions);

  if (plan.notice) setArtifactCardNote(card, plan.notice);
  return card;
}

/**
 * Button-less chip markup for the markdown renderer: an artifact path that has
 * not been checked yet still shows its name and type instead of a bare path or
 * a misleading "image unavailable" line. Surfaces replace it with the full card
 * once they can read the file.
 *
 * @param {unknown} pathRef
 * @returns {string} HTML, or '' when the reference is not a local file artifact
 */
export function artifactFileChipMarkup(pathRef) {
  const plan = artifactActionPlan(pathRef);
  if (!plan.local || !plan.source) return '';
  const name = escapeHtml(plan.name);
  const source = escapeHtml(plan.source);
  return `<section class="${ARTIFACT_CARD_CLASS} ${ARTIFACT_CARD_CHIP_CLASS}" data-artifact-path="${source}"`
    + ` data-artifact-kind="${escapeHtml(plan.kind)}" data-artifact-family="${escapeHtml(plan.family)}" data-artifact-state="pending" role="status" aria-label="${name}">`
    + `<div class="artifact-card-head"><span class="artifact-card-kind" aria-hidden="true">${escapeHtml(plan.badge)}</span>`
    + `<div class="artifact-card-copy"><strong class="artifact-card-name" title="${source}">${name}</strong>`
    + `<small class="artifact-card-source">${source}</small></div></div></section>`;
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

export const DEFAULT_ARTIFACT_CARD_LIMIT = 6;

function labelSet(labels) {
  return cardLabels(typeof labels === 'function' ? labels() : labels);
}

function handlerSet(handlers) {
  const value = typeof handlers === 'function' ? handlers() : handlers;
  return value && typeof value === 'object' ? value : {};
}

// Text blocks that may name a returned file: paragraphs and list items, never
// code blocks (tool dumps) and never inside a card that is already there.
export function artifactTextBlocks(root) {
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll('p, li')].filter((node) => {
    if (node.closest?.('.artifact-card')) return false;
    if (node.closest?.('pre')) return false;
    return Boolean(String(node.textContent || '').trim());
  });
}

// Cards already sitting directly after a block, keyed by the path they show.
export function artifactCardsAfter(block) {
  const cards = new Map();
  let node = block?.nextElementSibling;
  while (node?.classList?.contains(ARTIFACT_CARD_CLASS)) {
    const path = node.getAttribute?.('data-artifact-path') || '';
    if (path) cards.set(path, node);
    node = node.nextElementSibling;
  }
  return cards;
}

/**
 * Turn every artifact reference in a rendered transcript into an actionable
 * card: pending chips from the markdown renderer are upgraded in place, and a
 * path written as ordinary text grows a card right after its paragraph (after
 * the list for a list item). Idempotent — a second pass over the same DOM does
 * nothing — and self-healing: a card stranded in the unreadable state is
 * re-planned once the surface can read files again.
 *
 * @param {object} root Element whose subtree to hydrate.
 * @param {{
 *   buildPlan: (filePath: string) => Promise<{ plan: object, size?: number|null }|object>,
 *   labels?: object|(() => object),
 *   handlers?: object|(() => object),
 *   scanText?: boolean,
 *   limit?: number,
 * }} options
 * @returns {Promise<number>} cards placed (or refreshed)
 */
export async function hydrateArtifactCards(root, {
  buildPlan,
  labels = {},
  handlers = {},
  scanText = true,
  limit = DEFAULT_ARTIFACT_CARD_LIMIT,
} = {}) {
  if (typeof buildPlan !== 'function' || !root?.querySelectorAll) return 0;
  const doc = root.ownerDocument || root.parentDocument || null;
  if (!doc?.createElement) return 0;
  const text = labelSet(labels);
  const actionHandlers = handlerSet(handlers);
  const cap = Math.max(1, Number(limit) || DEFAULT_ARTIFACT_CARD_LIMIT);
  let budget = cap;
  let placed = 0;

  const buildCard = (plan, size) => buildArtifactFileCard(doc, plan, { labels: text, handlers: actionHandlers, size });

  const chips = [...root.querySelectorAll(`.${ARTIFACT_CARD_CHIP_CLASS}[data-artifact-path]`)].slice(0, cap);
  for (const chip of chips) {
    if (budget <= 0) break;
    const filePath = chip.getAttribute('data-artifact-path') || '';
    if (!filePath) continue;
    const { plan, size } = (await buildPlan(filePath)) || {};
    if (!plan || !chip.parentNode) continue;
    chip.replaceWith(buildCard(plan, size));
    placed += 1;
    budget -= 1;
  }

  // A card rendered before the surface could read files heals itself once a
  // plan succeeds, instead of staying dead for the rest of the session.
  const stranded = [...root.querySelectorAll('.artifact-card[data-artifact-state="unreadable"]')]
    .filter((card) => card.dataset?.artifactBusy !== 'true')
    .slice(0, cap);
  for (const card of stranded) {
    if (budget <= 0) break;
    const filePath = card.getAttribute('data-artifact-path') || '';
    if (!filePath) continue;
    const { plan, size } = (await buildPlan(filePath)) || {};
    if (!plan || plan.readable !== true || !card.parentNode) continue;
    card.replaceWith(buildCard(plan, size));
    placed += 1;
    budget -= 1;
  }
  if (!scanText || budget <= 0) return placed;

  for (const block of artifactTextBlocks(root)) {
    if (budget <= 0) break;
    const paths = extractArtifactPaths(block.textContent || '', { limit: budget });
    if (!paths.length) continue;
    // A list item carries its card after the list, so the list stays legal.
    const anchor = block.tagName === 'LI' ? (block.closest?.('ul, ol') || block) : block;
    const cards = artifactCardsAfter(anchor);
    for (const descriptor of paths) {
      if (budget <= 0) break;
      if (cards.has(descriptor.source)) continue;
      const { plan, size } = (await buildPlan(descriptor.source)) || {};
      if (!plan) continue;
      const card = buildCard(plan, size);
      const tail = [...cards.values()].at(-1) || anchor;
      if (typeof tail.after === 'function') tail.after(card);
      else tail.insertAdjacentElement?.('afterend', card);
      cards.set(descriptor.source, card);
      placed += 1;
      budget -= 1;
    }
  }
  return placed;
}
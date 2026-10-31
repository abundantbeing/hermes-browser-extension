// Visual option cards for the response style and chat layout choices, shared
// by Settings > Appearance & Themes and the first-run setup so both look the
// same. Each card is a radio with a tiny drawn preview of what the option
// does: no text inside the drawing, so it reads the same in every language,
// and only theme tokens, so it reads in every theme and mode.

import { escapeHtml } from './common.mjs';

export const RESPONSE_STYLE_OPTIONS = Object.freeze([
  { value: 'vivid', title: 'responses.style.vivid', hint: 'responses.style.vivid_hint' },
  { value: 'rich', title: 'responses.style.rich', hint: 'responses.style.rich_hint' },
  { value: 'plain', title: 'responses.style.plain', hint: 'responses.style.plain_hint' },
]);

export const MESSAGE_LAYOUT_OPTIONS = Object.freeze([
  { value: 'bubbles', title: 'responses.layout.bubbles', hint: 'responses.layout.bubbles_hint' },
  { value: 'user-bubble', title: 'responses.layout.user_bubble', hint: 'responses.layout.user_bubble_hint' },
]);

const OPTIONS = Object.freeze({ style: RESPONSE_STYLE_OPTIONS, layout: MESSAGE_LAYOUT_OPTIONS });

// Each drawing is a miniature chat: the user's bubble, then Hermes' reply.
const STYLE_REPLIES = Object.freeze({
  vivid: '<i class="pv-stats"><i class="pv-stat"><b></b><em></em></i><i class="pv-stat"><b></b><em></em></i></i><i class="pv-chart"><b></b><b></b><b></b><b></b><b></b></i>',
  rich: '<i class="pv-heading"></i><i class="pv-item"></i><i class="pv-item short"></i><i class="pv-code"><b></b><b></b></i>',
  plain: '<i class="pv-line"></i><i class="pv-line"></i><i class="pv-line"></i><i class="pv-line short"></i>',
});

const LAYOUT_THREADS = Object.freeze({
  bubbles: '<i class="pv-user"></i><i class="pv-reply-bubble"><i class="pv-line"></i><i class="pv-line short"></i></i><i class="pv-user short"></i>',
  'user-bubble': '<i class="pv-user"></i><i class="pv-reply-flow"><i class="pv-line"></i><i class="pv-line"></i><i class="pv-line short"></i></i><i class="pv-user short"></i>',
});

export function presentationPreviewHtml(group, value) {
  if (group === 'layout') {
    const thread = LAYOUT_THREADS[value] || LAYOUT_THREADS.bubbles;
    return `<span class="presentation-preview pv-layout pv-${escapeHtml(value)}" aria-hidden="true">${thread}</span>`;
  }
  const reply = STYLE_REPLIES[value] || STYLE_REPLIES.rich;
  return `<span class="presentation-preview pv-style pv-${escapeHtml(value)}" aria-hidden="true"><i class="pv-user"></i><i class="pv-reply">${reply}</i></span>`;
}

export function presentationOptionLabelKey(group, value) {
  const options = OPTIONS[group] || [];
  return (options.find((option) => option.value === value) || options[0])?.title || '';
}

function cardHtml(group, option, { selected, attribute, translate }) {
  const title = translate(option.title);
  const hint = translate(option.hint);
  return `<button type="button" class="presentation-card${selected ? ' selected' : ''}" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" ${attribute}="${escapeHtml(option.value)}" data-radio-key="${escapeHtml(`${group}:${option.value}`)}" title="${escapeHtml(hint)}">${presentationPreviewHtml(group, option.value)}<span class="presentation-card-label">${escapeHtml(title)}</span><span class="presentation-card-check" aria-hidden="true"></span></button>`;
}

// The cards plus one line under them describing the selected option, so the
// cards themselves stay small enough for three in a row in the side panel.
export function presentationCardsHtml(group, { selected = '', attribute, translate = (key) => key } = {}) {
  const options = OPTIONS[group] || [];
  const current = options.find((option) => option.value === selected) || null;
  const cards = options.map((option) => cardHtml(group, option, { selected: option === current, attribute, translate })).join('');
  const hint = current ? translate(current.hint) : '';
  return `<span class="presentation-cards presentation-cards-${group}">${cards}</span><span class="presentation-selected-hint">${escapeHtml(hint)}</span>`;
}

// Updates a rendered group in place (keeping focus) and only rebuilds it when
// the copy changed, for example after a language switch.
export function syncPresentationCards(container, group, { selected = '', attribute, translate = (key) => key, sanitize = (html) => html } = {}) {
  if (!container) return;
  const signature = (OPTIONS[group] || []).map((option) => `${translate(option.title)}|${translate(option.hint)}`).join('||');
  if (container.dataset.presentationSignature !== signature) {
    container.innerHTML = sanitize(presentationCardsHtml(group, { selected, attribute, translate }));
    container.dataset.presentationSignature = signature;
    return;
  }
  let current = null;
  for (const card of container.querySelectorAll('.presentation-card')) {
    const isSelected = card.getAttribute(attribute) === selected;
    if (isSelected) current = card;
    card.classList.toggle('selected', isSelected);
    card.setAttribute('aria-checked', String(isSelected));
    card.tabIndex = isSelected ? 0 : -1;
  }
  const option = (OPTIONS[group] || []).find((entry) => entry.value === selected);
  const hint = container.querySelector('.presentation-selected-hint');
  if (hint) hint.textContent = option ? translate(option.hint) : '';
  if (!current) container.querySelector('.presentation-card')?.setAttribute('tabindex', '0');
}

// Radio-group keys for any group of [role="radio"] cards: arrows move and
// select, Home and End jump. The card is clicked so the caller's own click
// handler applies the choice; focus then returns to the card with the same
// key, even when the click re-rendered the group. A group marked
// data-radio-activation="manual" only moves focus: the card is chosen with
// Enter, Space or a click, so nothing is applied (or saved) for a card the
// keyboard merely passed over.
export function handleRadioCardKeydown(event, root) {
  const card = event.target?.closest?.('[role="radio"][data-radio-key]');
  const group = card?.closest?.('[role="radiogroup"]');
  if (!card || !group) return false;
  const cards = [...group.querySelectorAll('[role="radio"][data-radio-key]')];
  const index = cards.indexOf(card);
  // Left and Right follow the reading direction: in right-to-left text the
  // next card is the one on the left.
  const direction = (group.closest('[dir]')?.getAttribute('dir') || group.ownerDocument?.documentElement?.getAttribute('dir') || '').toLowerCase();
  const horizontal = direction === 'rtl' ? -1 : 1;
  const moves = { ArrowRight: horizontal, ArrowDown: 1, ArrowLeft: -horizontal, ArrowUp: -1 };
  let next = null;
  if (event.key in moves) next = cards[(index + moves[event.key] + cards.length) % cards.length];
  else if (event.key === 'Home') next = cards[0];
  else if (event.key === 'End') next = cards[cards.length - 1];
  if (!next) return false;
  event.preventDefault();
  if (group.dataset?.radioActivation === 'manual') {
    next.focus();
    return true;
  }
  const key = next.dataset.radioKey;
  next.click();
  const target = [...(root || group).querySelectorAll('[data-radio-key]')].find((node) => node.dataset.radioKey === key);
  target?.focus();
  return true;
}

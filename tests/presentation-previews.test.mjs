import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  MESSAGE_LAYOUT_OPTIONS,
  RESPONSE_STYLE_OPTIONS,
  handleRadioCardKeydown,
  presentationCardsHtml,
  presentationPreviewHtml,
  syncPresentationCards,
} from '../extension/lib/presentation-previews.mjs';

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const translate = (key) => `T(${key})`;

function mount(group, selected) {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="c" role="radiogroup"></div></body></html>');
  const container = document.getElementById('c');
  const attribute = group === 'style' ? 'data-response-style' : 'data-message-layout';
  const sync = (value) => syncPresentationCards(container, group, { selected: value, attribute, translate });
  sync(selected);
  return { document, window, container, attribute, sync };
}

test('every option has its own drawn preview and no text inside it', () => {
  assert.deepEqual(RESPONSE_STYLE_OPTIONS.map((option) => option.value), ['vivid', 'rich', 'plain']);
  assert.deepEqual(MESSAGE_LAYOUT_OPTIONS.map((option) => option.value), ['bubbles', 'user-bubble']);
  const previews = {
    vivid: presentationPreviewHtml('style', 'vivid'),
    rich: presentationPreviewHtml('style', 'rich'),
    plain: presentationPreviewHtml('style', 'plain'),
    bubbles: presentationPreviewHtml('layout', 'bubbles'),
    'user-bubble': presentationPreviewHtml('layout', 'user-bubble'),
  };
  assert.equal(new Set(Object.values(previews)).size, 5, 'five distinct drawings');
  assert.match(previews.vivid, /pv-stat[\s\S]*pv-chart/, 'Vivid UI shows metric cards and a chart');
  assert.match(previews.rich, /pv-heading[\s\S]*pv-item[\s\S]*pv-code/, 'Rich text shows a heading, a list and code');
  assert.doesNotMatch(previews.plain, /pv-heading|pv-item|pv-code|pv-stat/, 'Plain text is flat lines only');
  assert.match(previews.bubbles, /pv-user[\s\S]*pv-reply-bubble/, 'both sides in bubbles');
  assert.match(previews['user-bubble'], /pv-user[\s\S]*pv-reply-flow/);
  assert.doesNotMatch(previews['user-bubble'], /pv-reply-bubble/, 'Hermes has no bubble in user-bubble-only');
  for (const html of Object.values(previews)) {
    assert.match(html, /aria-hidden="true"/);
    const { document } = parseHTML(`<div id="x">${html}</div>`);
    assert.equal(document.getElementById('x').textContent, '', 'drawings carry no words');
  }
});

test('cards are labelled radios with one selected and a hint for it', () => {
  const html = presentationCardsHtml('style', { selected: 'rich', attribute: 'data-response-style', translate });
  const { document } = parseHTML(`<div id="c">${html}</div>`);
  const cards = [...document.querySelectorAll('[role="radio"]')];
  assert.deepEqual(cards.map((card) => card.querySelector('.presentation-card-label').textContent), ['T(responses.style.vivid)', 'T(responses.style.rich)', 'T(responses.style.plain)']);
  assert.deepEqual(cards.map((card) => card.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.deepEqual(cards.map((card) => card.getAttribute('tabindex')), ['-1', '0', '-1'], 'roving tabindex');
  assert.equal(cards[1].getAttribute('title'), 'T(responses.style.rich_hint)');
  assert.equal(document.querySelector('.presentation-selected-hint').textContent, 'T(responses.style.rich_hint)');
});

test('syncing updates the same cards in place and rebuilds only when copy changes', () => {
  const { container, sync } = mount('layout', 'bubbles');
  const first = container.querySelector('[data-message-layout="user-bubble"]');
  sync('user-bubble');
  const after = container.querySelector('[data-message-layout="user-bubble"]');
  assert.equal(after, first, 'the node survives, so focus does too');
  assert.equal(after.getAttribute('aria-checked'), 'true');
  assert.equal(after.classList.contains('selected'), true);
  assert.equal(container.querySelector('[data-message-layout="bubbles"]').getAttribute('tabindex'), '-1');
  assert.equal(container.querySelector('.presentation-selected-hint').textContent, 'T(responses.layout.user_bubble_hint)');
  syncPresentationCards(container, 'layout', { selected: 'user-bubble', attribute: 'data-message-layout', translate: (key) => `NL(${key})` });
  assert.notEqual(container.querySelector('[data-message-layout="user-bubble"]'), first, 'a language switch rebuilds');
  assert.match(container.textContent, /NL\(responses\.layout\.user_bubble\)/);
});

test('arrow keys move and select like a radio group', () => {
  const { container, sync, attribute } = mount('style', 'vivid');
  container.addEventListener('click', (event) => {
    const card = event.target.closest(`[${attribute}]`);
    if (card) sync(card.getAttribute(attribute));
  });
  const press = (key) => {
    const current = container.querySelector('[aria-checked="true"]');
    const event = { key, target: current, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    return handleRadioCardKeydown(event, container);
  };
  const selected = () => container.querySelector('[aria-checked="true"]').getAttribute(attribute);
  assert.equal(press('ArrowRight'), true);
  assert.equal(selected(), 'rich');
  press('ArrowDown');
  assert.equal(selected(), 'plain');
  press('ArrowRight');
  assert.equal(selected(), 'vivid', 'wraps around');
  press('End');
  assert.equal(selected(), 'plain');
  press('Home');
  assert.equal(selected(), 'vivid');
  assert.equal(press('a'), false, 'other keys pass through');
});

test('Appearance & Themes runs Font family, Theme, Response style, Chat layout', () => {
  const html = read('extension/sidepanel.html');
  const pane = html.slice(html.indexOf('id="settingsPane-appearance"'), html.indexOf('id="settingsPane-connections"'));
  const order = ['font-profile-setting', 'class="theme-setting"', 'id="responseStyleChoices"', 'id="messageLayoutChoices"', 'language-row', 'id="rerunOnboardingButton"']
    .map((marker) => pane.indexOf(marker));
  assert.ok(order.every((index) => index > 0), `all present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  assert.doesNotMatch(pane, /response-choice|segmented-control response/, 'no more segmented buttons');
  assert.match(pane, /id="responseStyleChoices" class="presentation-choices" role="radiogroup"/);
});

test('Run first-time setup again is a quiet row with an icon and a description', () => {
  const html = read('extension/sidepanel.html');
  const row = html.match(/<button id="rerunOnboardingButton"[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(row, /class="settings-setup-row"/);
  assert.doesNotMatch(row, /class="[^"]*secondary/, 'not an outlined secondary button');
  assert.match(row, /data-icon="reload"/);
  assert.match(row, /data-i18n="responses\.setup_again"/);
  assert.match(row, /data-i18n="responses\.setup_again_description"/);
  const css = read('extension/sidepanel.css');
  assert.match(css, /\.settings-setup-row \{[^}]*border: 0;[^}]*border-top: 1px solid var\(--hermes-line\);[^}]*background: transparent;/);
  const english = read('extension/lib/locales/en.mjs');
  assert.match(english, /"responses\.setup_again": "Run first-time setup again"/);
});

test('setup and Settings draw the same cards', () => {
  const flow = read('extension/lib/onboarding-flow.mjs');
  const panel = read('extension/sidepanel.js');
  assert.match(flow, /presentationCardsHtml\('style'/);
  assert.match(flow, /presentationCardsHtml\('layout'/);
  assert.match(panel, /syncPresentationCards\(els\.responseStyleChoices, 'style'/);
  assert.match(panel, /syncPresentationCards\(els\.messageLayoutChoices, 'layout'/);
  assert.match(panel, /handleRadioCardKeydown\(event, els\.responseStyleChoices\)/);
  assert.match(flow, /handleRadioCardKeydown\(event, host\)/);
});

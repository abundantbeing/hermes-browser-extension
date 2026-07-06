import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatPickedElementBlock,
  normalizePickedElement,
  pickedElementForTab,
  redactPickedElementText,
  storedPickedElementRecord,
} from '../extension/lib/element-picker.mjs';
import {
  buildBrowserContextPrompt,
  buildBrowserContextReceipt,
  browserContextPayloadHash,
} from '../extension/lib/browser-context-protocol.mjs';

test('normalizePickedElement rejects empty snapshots', () => {
  assert.equal(normalizePickedElement(null), null);
  assert.equal(normalizePickedElement({ ok: false }), null);
  assert.equal(normalizePickedElement({ ok: true }), null);
});

test('formatPickedElementBlock includes selector and text', () => {
  const block = formatPickedElementBlock({
    ok: true,
    tag: 'button',
    selector: 'button#save',
    text: 'Save changes',
    attributes: { id: 'save', role: 'button' },
  });
  assert.match(block, /Tag: button/);
  assert.match(block, /CSS selector: button#save/);
  assert.match(block, /Visible text: Save changes/);
});

test('formatPickedElementBlock redacts secrets from picked element prompt text', () => {
  const openAiLike = `sk-${'1234567890abcdef'}`;
  const githubLike = `ghp_${'123456789012345678901234567890123456'}`;
  const githubPatLike = `github_pat_${'1234567890123456789012345678901234567890_extra'}`;
  const block = formatPickedElementBlock({
    ok: true,
    tag: 'input',
    selector: 'input#token',
    text: `api_key=${openAiLike}`,
    attributes: { value: `Bearer ${githubLike}` },
    outerHtml: `<input value="${githubPatLike}">`,
  });
  assert.doesNotMatch(block, new RegExp(openAiLike));
  assert.doesNotMatch(block, new RegExp(githubLike));
  assert.doesNotMatch(block, new RegExp(githubPatLike));
  assert.match(block, /\[REDACTED_SECRET\]|\[REDACTED_BEARER\]/);
  assert.equal(redactPickedElementText('password=hunter2'), 'password=[REDACTED_SECRET]');
});

test('picked element storage is URL-scoped to prevent stale DOM reuse', () => {
  const record = storedPickedElementRecord({
    tabId: 7,
    url: 'https://example.com/page-a',
    pickedElement: { ok: true, tag: 'button', selector: 'button#save', text: 'Save' },
  });
  assert.ok(record);
  assert.equal(pickedElementForTab(record, { id: 7, url: 'https://example.com/page-a' })?.selector, 'button#save');
  assert.equal(pickedElementForTab(record, { id: 7, url: 'https://example.com/page-b' }), null);
  assert.equal(pickedElementForTab(record, { id: 7 }, { url: 'https://example.com/page-a' })?.selector, 'button#save');
  assert.equal(storedPickedElementRecord({ tabId: 7, pickedElement: { ok: true, tag: 'div', selector: 'div' } }), null);
});

test('buildBrowserContextPrompt includes picked element inside untrusted block', () => {
  const prompt = buildBrowserContextPrompt({
    userText: 'What is wrong with this button?',
    activeTab: { title: 'Demo', url: 'https://example.com/app' },
    tabs: [{ id: 1, active: true, title: 'Demo', url: 'https://example.com/app' }],
    contextScope: { mode: 'follow-active' },
    pageContext: {
      text: 'page body',
      pickedElement: {
        ok: true,
        tag: 'button',
        selector: 'button.cta',
        text: 'Buy now',
      },
    },
    settings: {
      contextDepth: 'normal',
      includeTabs: true,
      includePageText: true,
      includeSelectedText: true,
      maxTabs: 12,
    },
  });
  assert.match(prompt, /Picked element \(user-selected DOM node/);
  assert.match(prompt, /CSS selector: button\.cta/);
  assert.match(prompt, /UNTRUSTED_BROWSER_CONTEXT_END$/);
});

test('browserContextPayloadHash changes when picked element changes', () => {
  const base = {
    activeTab: { id: 1, title: 'Demo', url: 'https://example.com' },
    pageContext: { text: 'body' },
    settings: { contextDepth: 'normal', includeTabs: true, includePageText: true, includeSelectedText: true, maxTabs: 12 },
  };
  const without = browserContextPayloadHash(base);
  const withPick = browserContextPayloadHash({
    ...base,
    pageContext: {
      ...base.pageContext,
      pickedElement: { ok: true, tag: 'div', selector: 'div.hero', text: 'Hello' },
    },
  });
  assert.notEqual(without, withPick);
});

test('buildBrowserContextReceipt reports picked element row', () => {
  const receipt = buildBrowserContextReceipt({
    context: {
      activeTab: { title: 'Demo', url: 'https://example.com' },
      tabs: [],
      pageContext: {
        pickedElement: { ok: true, tag: 'a', selector: 'a.nav', text: 'Home' },
      },
      contextScope: { mode: 'follow-active' },
    },
    settings: { contextDepth: 'normal', includeTabs: true, includePageText: true, includeSelectedText: true, maxTabs: 12 },
  });
  const row = receipt.items.find((entry) => entry.label === 'Picked element');
  assert.ok(row);
  assert.match(row.value, /a\.nav/);
});
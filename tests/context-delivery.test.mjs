import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CONTEXT_DELIVERY_MODES,
  contextDeliveryDecision,
  recordContextDelivery,
} from '../extension/lib/context-delivery.mjs';
import {
  DEFAULT_BROWSER_CONTEXT_PROTOCOL_SETTINGS,
  buildBrowserContextPrompt,
  buildBrowserContextReceipt,
  buildChatOnlyPrompt,
} from '../extension/lib/browser-context-protocol.mjs';

test('context delivery sends full on first/change/stale and rotates after three references', () => {
  const now = 1_000_000;
  assert.equal(contextDeliveryDecision({ contextHash: 'aaa', previous: null, now }).mode, CONTEXT_DELIVERY_MODES.FULL);
  const full = recordContextDelivery(null, { mode: 'full', contextHash: 'aaa', now });
  assert.equal(contextDeliveryDecision({ contextHash: 'aaa', previous: full, now: now + 1 }).mode, CONTEXT_DELIVERY_MODES.REFERENCE);
  let state = full;
  for (let index = 0; index < 3; index += 1) state = recordContextDelivery(state, { mode: 'reference', contextHash: 'aaa', now: now + index + 1 });
  assert.equal(contextDeliveryDecision({ contextHash: 'aaa', previous: state, now: now + 5 }).mode, CONTEXT_DELIVERY_MODES.FULL);
  assert.equal(contextDeliveryDecision({ contextHash: 'bbb', previous: full, now: now + 5 }).mode, CONTEXT_DELIVERY_MODES.FULL);
  assert.equal(contextDeliveryDecision({ contextHash: 'aaa', previous: full, now: now + 11 * 60 * 1000 }).mode, CONTEXT_DELIVERY_MODES.FULL);
});

test('chat-only requires no browser delivery and sends raw user text', () => {
  assert.equal(contextDeliveryDecision({ scopeMode: 'chat-only', contextHash: '', previous: null }).mode, CONTEXT_DELIVERY_MODES.NONE);
  assert.equal(buildChatOnlyPrompt('  hello Hermes  '), 'hello Hermes');
  assert.equal(buildChatOnlyPrompt('[Mode: ordinary user text]'), '[Mode: ordinary user text]');
});

test('reference prompt contains the request and hash but no repeated page data', () => {
  const prompt = buildBrowserContextPrompt({
    userText: 'What changed?',
    activeTab: { title: 'Page title', url: 'https://example.com/docs' },
    tabs: [{ title: 'Other tab', url: 'https://example.com/other' }],
    pageContext: { selectedText: 'selected secret', text: 'FULL PAGE BODY', meta: { description: 'metadata' } },
    contextScope: { mode: 'follow-active' },
    settings: { ...DEFAULT_BROWSER_CONTEXT_PROTOCOL_SETTINGS, includeTabs: true },
    contextHash: 'abcdef1234567890',
    contextDelivery: 'reference',
  });
  assert.match(prompt, /What changed\?/);
  assert.match(prompt, /abcdef1234567890/);
  assert.match(prompt, /unchanged/i);
  assert.doesNotMatch(prompt, /FULL PAGE BODY|selected secret|Other tab|metadata/);
});

test('receipt exposes full versus unchanged-reference delivery', () => {
  const base = {
    context: { activeTab: { title: 'Page', url: 'https://example.com' }, tabs: [], selectedTabs: [], contextScope: { mode: 'follow-active' }, pageContext: { text: 'body' } },
    settings: DEFAULT_BROWSER_CONTEXT_PROTOCOL_SETTINGS,
    contextHash: 'abcdef1234567890',
  };
  const full = buildBrowserContextReceipt({ ...base, contextDelivery: 'full' });
  const reference = buildBrowserContextReceipt({ ...base, contextDelivery: 'reference' });
  assert.equal(full.items.find((item) => item.label === 'Delivery').value, 'Full snapshot');
  assert.equal(reference.items.find((item) => item.label === 'Delivery').value, 'Unchanged-context reference');
});

test('new protocol defaults omit extra open tabs and common delegates chat-only framing', () => {
  assert.equal(DEFAULT_BROWSER_CONTEXT_PROTOCOL_SETTINGS.includeTabs, false);
  const commonSource = readFileSync(new URL('../extension/lib/common.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(commonSource, /function buildChatOnlyPrompt\s*\(/);
  assert.match(commonSource, /protocolBuildChatOnlyPrompt\(userText\)/);
});

test('sidepanel records delivery only after a successful answer and resets on compaction', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /contextDeliveryDecision\(/);
  assert.match(source, /const finalAnswer =[\s\S]*contextDeliveryBySession\.set\(/);
  assert.match(source, /contextDeliveryBySession\.clear\(\)/);
  assert.match(source, /forceFullContextNextTurn/);
  assert.match(source, /serializeBrowserTurnEnvelope\(\{[\s\S]*contextDelivery/);
  assert.match(source, /buildContextReceipt\([\s\S]*contextDelivery/);
});

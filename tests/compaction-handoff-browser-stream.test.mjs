import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeGatewayHistoryMessages } from '../extension/lib/gateway-ws.mjs';
import {
  browserDisplayMessages,
  isBrowserDisplayMessageVisible,
} from '../extension/lib/web-run-state.mjs';

const productionRows = [
  {
    id: 'assistant-merged',
    role: 'assistant',
    text: 'done',
    finish_reason: 'stop',
    display_kind: 'normal',
  },
  {
    id: 'handoff-hidden',
    role: 'user',
    text: '',
    display_kind: 'hidden',
  },
  {
    id: 'real-user',
    role: 'user',
    text: 'continue with the next task',
    display_kind: 'normal',
  },
  {
    id: 'live-tool-loop',
    role: 'assistant',
    text: 'I ran the requested tool.',
    display_kind: 'normal',
    tool_calls: [{ id: 'tool-1' }],
  },
  {
    id: 'marker-authored-by-user',
    role: 'user',
    text: 'Explain the literal string [CONTEXT COMPACTION — REFERENCE ONLY]',
    display_kind: 'normal',
  },
];

test('Browser consumes Agent projected content and display_kind without classifying compaction markers', () => {
  const normalized = normalizeGatewayHistoryMessages({ messages: productionRows });
  assert.deepEqual(normalized.map(({ id, content, display_kind }) => ({ id, content, display_kind })), [
    { id: 'assistant-merged', content: 'done', display_kind: 'normal' },
    { id: 'handoff-hidden', content: '', display_kind: 'hidden' },
    { id: 'real-user', content: 'continue with the next task', display_kind: 'normal' },
    { id: 'live-tool-loop', content: 'I ran the requested tool.', display_kind: 'normal' },
    { id: 'marker-authored-by-user', content: 'Explain the literal string [CONTEXT COMPACTION — REFERENCE ONLY]', display_kind: 'normal' },
  ]);

  const visible = browserDisplayMessages(normalized);
  assert.deepEqual(visible.map((message) => message.id), [
    'assistant-merged',
    'real-user',
    'live-tool-loop',
    'marker-authored-by-user',
  ]);
  assert.equal(normalized.some((message) => message.id === 'handoff-hidden'), true, 'hidden identity remains reconcilable');
  assert.equal(isBrowserDisplayMessageVisible(productionRows.at(-1)), true, 'marker text is ordinary user content');
});

test('both Browser history surfaces use the field-driven display policy and preserve hidden identity rows', () => {
  const app = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const policy = readFileSync(new URL('../extension/lib/web-run-state.mjs', import.meta.url), 'utf8');

  assert.match(app, /browserDisplayMessages\(messages\)/);
  assert.match(sidepanel, /for \(const message of browserDisplayMessages\(messages\)\)/);
  assert.match(sidepanel, /messages:\s*contextMessages/);
  assert.match(sidepanel, /\.\.\.message,[\s\S]*?display_kind/);
  assert.doesNotMatch(policy, /CONTEXT COMPACTION|PRIOR CONTEXT|reference only/i);
  assert.doesNotMatch(app, /CONTEXT COMPACTION|PRIOR CONTEXT/);
  assert.doesNotMatch(sidepanel, /CONTEXT COMPACTION|PRIOR CONTEXT/);

  const fullTabStart = app.indexOf('async function commitFullTabSessionMessages');
  const fullTabEnd = app.indexOf('async function openSession', fullTabStart);
  const sidePanelStart = sidepanel.indexOf('async function commitFetchedSessionMessages');
  const sidePanelEnd = sidepanel.indexOf('async function loadSessionMessages', sidePanelStart);
  const fullTabCommit = app.slice(fullTabStart, fullTabEnd);
  const sidePanelCommit = sidepanel.slice(sidePanelStart, sidePanelEnd);
  assert.ok(fullTabStart >= 0 && fullTabEnd > fullTabStart);
  assert.ok(sidePanelStart >= 0 && sidePanelEnd > sidePanelStart);
  assert.match(fullTabCommit, /renderMessages/);
  assert.doesNotMatch(fullTabCommit, /sendPrompt|readHermesSse|executeBrowserCommand|tool/);
  assert.match(sidePanelCommit, /renderMessagesFromStorage/);
  assert.doesNotMatch(sidePanelCommit, /streamSessionChat|sendMessage|executeBrowserCommand|tool/);
});

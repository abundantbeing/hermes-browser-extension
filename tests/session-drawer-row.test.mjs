import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createSettingsSaveHarness } from './helpers/settings-save-harness.mjs';

const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

// The real renderSessionMenu with the real drawer markup; only what feeds it sessions is stubbed.
async function drawer(sessions, { canMove = true } = {}) {
  const h = await createSettingsSaveHarness({ settings: { sessionId: 'a1' } });
  const scope = h.scope;
  scope.availableSessions = sessions;
  scope.liveDiscoveredSessions = [];
  scope.liveSessionRows = new Map();
  scope.liveSessionRosterScope = '';
  scope.liveAttach = null;
  scope.localSessionStream = null;
  scope.activeRunControl = null;
  scope.activeGroupProjection = null;
  scope.openSessionGroups = new Set(['Recent']);
  scope.closedSessionGroups = new Set();
  scope.scheduleLiveSessionPoll = () => {};
  scope.syncSessionMenuChrome = () => {};
  scope.projectsTabActive = () => false;
  scope.sessionMenuGroups = () => [{ label: 'Recent', source: 'hermes_api', sessions }];
  scope.shouldAutoOpenSessionGroup = () => false;
  scope.getProjectsController = () => ({ availability: () => ({ available: canMove }) });
  scope.currentSubagentItems = () => [];
  scope.liveSessionScopeKey = () => 'scope';
  scope.isSessionRenameEditorTarget = () => false;
  scope.mergeLiveSignals = () => ({ state: 'idle', live: false, label: '' });
  scope.translateUiText = (text) => text;
  scope.t = (key, params = {}) => (key === 'session.row_model' ? `Model: ${params.model}` : key === 'ui.messages' ? 'Messages' : key);
  scope.friendlyModelName = (id) => `friendly(${id})`;
  scope.safeActiveProfile = () => '';
  h.fn('renderSessionMenu')('');
  return h;
}

const rows = (h) => [...h.els.sessionMenuList.querySelectorAll('.session-option-row')];

test('a drawer row has the title and the ID, Rename and Move buttons, and no model column', async () => {
  const h = await drawer([
    { id: 'a1', title: 'Fix the login bug', rawModelId: 'claude-haiku-4-5', messageCount: 12, selected: false },
    { id: 'b2', title: 'Plan the launch', model: 'gpt-5', selected: false },
  ]);
  const [first, second] = rows(h);
  for (const row of [first, second]) {
    const button = row.querySelector('.session-option');
    assert.equal(button.querySelector('.session-option-name').textContent.length > 0, true);
    assert.equal(button.querySelector('.session-option-meta'), null, 'no model or count in the row');
    assert.equal(button.children.length, 1, 'the title is the only cell, so it gets the room');
    assert.deepEqual([...row.querySelectorAll('.session-action-button')].map((node) => node.textContent), ['ID', 'Rename', 'projects.move.action']);
  }
  assert.ok(!first.textContent.includes('friendly('), 'the model name is not drawn in the row');
});

test('the model and message count are in the row tooltip instead', async () => {
  const h = await drawer([
    { id: 'a1', title: 'Fix the login bug', rawModelId: 'claude-haiku-4-5', messageCount: 12, selected: false },
    { id: 'b2', title: 'Plan the launch', selected: false },
  ]);
  const [first, second] = rows(h);
  assert.equal(first.querySelector('.session-option').title, 'Fix the login bug\nModel: friendly(claude-haiku-4-5)\nMessages: 12');
  assert.equal(second.querySelector('.session-option').title, 'Plan the launch');
});

test('the selected row still shows its check, and ID, Rename and Move are unchanged', async () => {
  const h = await drawer([{ id: 'a1', title: 'Fix the login bug', rawModelId: 'claude-haiku-4-5', selected: true }], { canMove: false });
  const [row] = rows(h);
  assert.equal(row.querySelector('.session-option-meta').textContent, '✓');
  assert.deepEqual([...row.querySelectorAll('.session-action-button')].map((node) => node.textContent), ['ID', 'Rename'], 'Move only where the gateway offers it');
});

test('long titles ellipsize and the buttons keep one line at narrow widths and with text zoom', () => {
  assert.match(css, /\.session-option-name \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\.session-action-button \{ flex: none; white-space: nowrap; \}/);
  assert.match(css, /\.session-actions \{ flex: none; flex-wrap: nowrap; \}/);
  // The title keeps about 9em; below that the buttons drop under it instead of crowding it.
  const wrap = css.match(/\.session-menu-list \.session-option-row:not\(\.renaming\) \{([^}]*)\}/)?.[1] || '';
  assert.match(wrap, /display: flex;/);
  assert.match(wrap, /flex-wrap: wrap;/);
  assert.match(css, /\.session-menu-list \.session-option-row:not\(\.renaming\) > \.session-option \{[^}]*flex: 1 1 9em;[^}]*min-width: 0;/);
});

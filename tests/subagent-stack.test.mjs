import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  SUBAGENT_EVENT_TYPES,
  activeSubagentView,
  applySubagentEvent,
  formatSubagentTool,
  pruneFinishedSubagents,
  reconcileSubagentSnapshot,
  subagentControlPayload,
  subagentStackSummary,
  visibleSubagentView,
  subagentsFromListResult,
} from '../extension/lib/subagent-stack.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('known subagent event names are locked', () => {
  assert.deepEqual([...SUBAGENT_EVENT_TYPES], [
    'subagent.spawn_requested',
    'subagent.start',
    'subagent.thinking',
    'subagent.tool',
    'subagent.progress',
    'subagent.complete',
  ]);
});

test('start + tool + complete become one child with model and ticker', () => {
  let state = {};
  state = applySubagentEvent(state, 'sess-live', {
    type: 'subagent.start',
    payload: {
      subagent_id: 'child-1',
      goal: 'Audit Desktop subagent UI',
      model: 'z-ai/glm-5.3-flash',
      status: 'running',
    },
  });
  state = applySubagentEvent(state, 'sess-live', {
    type: 'subagent.tool',
    payload: {
      subagent_id: 'child-1',
      tool_name: 'read_file',
      tool_preview: 'subagents.ts',
    },
  });
  const live = activeSubagentView(state['sess-live']);
  assert.equal(live.length, 1);
  assert.equal(live[0].goal, 'Audit Desktop subagent UI');
  assert.equal(live[0].model, 'z-ai/glm-5.3-flash');
  assert.equal(live[0].currentTool, 'Read File("subagents.ts")');
  assert.equal(live[0].stream.at(-1).kind, 'tool');

  state = applySubagentEvent(state, 'sess-live', {
    type: 'subagent.complete',
    payload: { subagent_id: 'child-1', status: 'completed', summary: 'Done' },
  });
  assert.equal(activeSubagentView(state['sess-live']).length, 0);
  assert.equal(visibleSubagentView(state['sess-live']).length, 1);
  assert.equal(visibleSubagentView(state['sess-live'])[0].summary, 'Done');
  assert.equal(subagentStackSummary(state['sess-live']), '1 done');
  state = pruneFinishedSubagents(state, 'sess-live');
  assert.equal(state['sess-live'].length, 0);
});

test('timeout and cancelled map to failed / interrupted, never spin as running', () => {
  let state = applySubagentEvent({}, 's', {
    type: 'subagent.complete',
    payload: { subagent_id: 'x', goal: 'Hang', status: 'timeout' },
  });
  assert.equal(state.s[0].status, 'failed');
  state = applySubagentEvent({}, 's', {
    type: 'subagent.complete',
    payload: { subagent_id: 'y', goal: 'Stop', status: 'cancelled' },
  });
  assert.equal(state.s[0].status, 'interrupted');
});

test('snapshot hydrate fills missing live rows without wiping stream history', () => {
  let state = applySubagentEvent({}, 's', {
    type: 'subagent.start',
    payload: { subagent_id: 'child-1', goal: 'Keep stream', model: 'gpt-5.6' },
  });
  state = applySubagentEvent(state, 's', {
    type: 'subagent.tool',
    payload: { subagent_id: 'child-1', tool_name: 'web_search', tool_preview: 'query' },
  });
  state = reconcileSubagentSnapshot(state, 's', subagentsFromListResult({
    subagents: [
      { subagent_id: 'child-1', goal: 'Keep stream', model: 'gpt-5.6', status: 'running', last_tool: 'read_file' },
      { subagent_id: 'child-2', goal: 'New from snapshot', model: 'glm-5.3-flash', status: 'queued' },
    ],
  }));
  const live = activeSubagentView(state.s);
  assert.equal(live.length, 2);
  assert.match(live[0].currentTool, /Web Search/);
  assert.equal(live[1].goal, 'New from snapshot');
});

test('formatSubagentTool matches Desktop label style', () => {
  assert.equal(formatSubagentTool('read_file', 'store/subagents.ts'), 'Read File("store/subagents.ts")');
  assert.equal(formatSubagentTool('web_search', ''), 'Web Search');
});

test('header summary names one model or a count, never a comma list', () => {
  assert.equal(subagentStackSummary([
    { status: 'running', model: 'z-ai/glm-5.3-flash' },
    { status: 'queued', model: 'z-ai/glm-5.3-flash' },
  ]), '2 live · glm-5.3-flash');
  assert.equal(subagentStackSummary([
    { status: 'running', model: 'gpt-5.6' },
    { status: 'running', model: 'glm-5.3-flash' },
  ]), '2 live · 2 models');
});

test('steer and interrupt payloads stay owner-scoped', () => {
  assert.deepEqual(subagentControlPayload('steer', {
    sessionId: 'sess-1',
    subagentId: 'child-1',
    text: 'keep going',
  }), {
    session_id: 'sess-1',
    subagent_id: 'child-1',
    text: 'keep going',
  });
  assert.deepEqual(subagentControlPayload('interrupt', {
    sessionId: 'sess-1',
    subagentId: 'child-1',
    text: 'ignored',
  }), {
    session_id: 'sess-1',
    subagent_id: 'child-1',
  });
});

test('sidepanel mounts a hidden-until-live SUBAGENTS stack beside TASKS', () => {
  const html = read('extension/sidepanel.html');
  const source = read('extension/sidepanel.js');
  const css = read('extension/sidepanel.css');
  assert.match(html, /id="subagentStack"/);
  assert.match(html, /subagent-stack-spinner/);
  assert.match(html, /id="taskStack"[\s\S]*id="subagentStack"/);
  assert.match(source, /applySubagentEvent/);
  assert.match(source, /WS_METHODS\.subagentList/);
  assert.match(source, /WS_METHODS\.subagentSteer/);
  assert.match(source, /WS_METHODS\.subagentInterrupt/);
  assert.match(source, /usesDashboardWsChatTransport\(\) \? 'dashboard-ws'/);
  assert.match(source, /async function runSelectedSubagentControl[\s\S]*?establishGatewaySession\(\{[\s\S]*?storedSessionId: durableSessionId/);
  assert.match(css, /\.subagent-stack/);
  assert.match(css, /contain:\s*layout/);
  assert.match(css, /\.subagent-stack\s*>\s*\.task-stack-toggle[\s\S]*grid-template-columns:\s*auto minmax\(0,1fr\) 20px/);
  assert.match(css, /\.subagent-stack-stream::-webkit-scrollbar/);
  assert.doesNotMatch(css, /\.subagent-stack[\s\S]{0,400}scrollbar-color/);
  assert.match(source, /Steer this subagent/);
  assert.match(source, /Stop this subagent/);
  assert.match(source, /SUBAGENT_STEER_ICON/);
  assert.match(css, /\.subagent-stack-controls[\s\S]*grid-template-columns:\s*minmax\(0,1fr\) 32px 32px/);
});

test('Hermes Web mounts the same SUBAGENTS stack', () => {
  const html = read('extension/app.html');
  const source = read('extension/app.js');
  assert.match(html, /id="subagentStack"/);
  assert.match(source, /applySubagentEvent/);
});

test('package check:js syntax-checks the subagent stack module', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(String(pkg.scripts?.['check:js'] || ''), /subagent-stack\.mjs/);
});

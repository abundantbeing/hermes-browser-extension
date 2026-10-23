// Per-session context and live-session restore in the side panel.
//
// Runs the panel's REAL wiring (sliced from extension/sidepanel.js) in a VM
// against a fake dashboard socket that answers like the gateway does:
// session.context_breakdown, session.usage, subagent.list and the pushed
// session.usage / message.complete / subagent.* events, all addressed by the
// LIVE runtime id that session.resume mints.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers';

import * as store from '../extension/lib/session-context-store.mjs';
import * as subagents from '../extension/lib/subagent-stack.mjs';
import { resolveContextOccupancy } from '../extension/lib/context-usage-view.mjs';
import { createSessionLineage } from '../extension/lib/session-lineage.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not slice ${from}`);
  return source.slice(start, end);
};
const contextSource = between('let sessionContextStore = emptySessionContextStore();', 'let dragDepth = 0;');
const subagentSource = between('function currentSubagentSessionKeys()', 'async function hydrateRestSubagentSnapshot(');
const steerSource = between('async function runSelectedSubagentControl(', 'function renderSubagentStack()');
const usedTokensSource = between('function currentSessionContextUsedTokens()', 'function requestSelectedModelWithContextConfirm(');

const breakdownFor = (used) => ({
  categories: [
    { id: 'system_prompt', label: 'System prompt', tokens: 16_200 },
    { id: 'tool_definitions', label: 'Tool definitions', tokens: 19_100 },
    { id: 'conversation', label: 'Conversation', tokens: used - 35_300 },
  ],
  context_max: 500_000,
  context_percent: Math.round(used / 5_000),
  context_used: used,
  context_source: 'provider_usage',
  context_estimated: false,
  estimated_total: used,
});

function fakeGateway(answers) {
  const listeners = new Map();
  const calls = [];
  const client = {
    readyState: 1,
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(params) : answer;
    },
    on: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    emit: (type, sessionId, payload) => {
      for (const fn of [...(listeners.get(type) || []), ...(listeners.get('*') || [])]) fn({ type, sessionId, payload });
    },
  };
  return client;
}

function panel({ answers = {} } = {}) {
  const timers = [];
  const storage = {};
  const client = fakeGateway(answers);
  const renders = [];
  const context = vm.createContext({
    ...store,
    ...subagents,
    resolveContextOccupancy,
    createSessionLineage,
    console,
    Date,
    browserApi: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, JSON.parse(storage[key])])),
          set: async (values) => { for (const [key, value] of Object.entries(values)) storage[key] = JSON.stringify(value); },
        },
      },
    },
    // Timers run only when the test flushes them, so retries are deterministic.
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    setInterval: () => 1,
    clearInterval: () => {},
    document: { hidden: false },
    settings: { sessionId: '' },
    activeConversationTransport: 'dashboard-ws',
    activeDashboardWsConnection: { client, wsSessionId: '', wsStoredSessionId: '' },
    remoteWsConnection: null,
    WS_METHODS: { sessionUsage: 'session.usage', contextBreakdown: 'session.context_breakdown', subagentList: 'subagent.list', subagentSteer: 'subagent.steer', subagentInterrupt: 'subagent.interrupt' },
    WS_EVENTS: { messageComplete: 'message.complete' },
    renderContextWindow: () => { renders.push(vm.runInContext('settings.sessionId', context)); },
    renderSubagentStack: () => {},
    usesDashboardWsChatTransport: () => true,
    hydrateRestSubagentSnapshot: async () => {},
    normalizeDelegationId: () => '',
    startDelegationWatch: async () => {},
    refreshSessionAfterSubagentsSettle: async () => {},
    safeActiveProfile: () => '',
    ensureActiveDashboardWsConnection: async () => context.activeDashboardWsConnection,
    restSubagentControl: async () => { throw new Error('REST must not be used on the dashboard transport'); },
    // session.resume mints a fresh live id for the durable session.
    establishGatewaySession: async ({ storedSessionId }) => ({ liveId: `${storedSessionId}-live-2`, storedId: storedSessionId }),
    loadedSessionContextEstimate: { sessionId: '', contextTokens: 0, visibleTokens: 0 },
    messages: [],
    estimateLocalSessionContextTokens: () => 0,
  });
  vm.runInContext(`
    let subagentState = {};
    let subagentExpanded = true;
    let subagentSelectedId = '';
    let subagentControlBusy = false;
    let subagentControlError = '';
    let subagentSteerDraft = '';
    let subagentTimer = null;
    const subagentBoundClients = new WeakSet();
  `, context);
  vm.runInContext(contextSource, context);
  vm.runInContext(subagentSource, context);
  vm.runInContext(steerSource, context);
  vm.runInContext(usedTokensSource, context);
  const run = (code) => vm.runInContext(code, context);
  return {
    context, client, storage, renders, timers, run,
    // Open a durable session the way openHermesSession leaves the state.
    open(storedId, liveId) {
      context.activeDashboardWsConnection.wsSessionId = liveId;
      context.activeDashboardWsConnection.wsStoredSessionId = storedId;
      run(`settings = { ...settings, sessionId: ${JSON.stringify(storedId)} }; rememberLiveSessionAlias(${JSON.stringify(liveId)}, ${JSON.stringify(storedId)}); bindContextTelemetryClient(activeDashboardWsConnection.client);`);
    },
    entry: (id) => run(`sessionContextEntry(sessionContextStore, ${JSON.stringify(id)})`),
    // Run due timers until none are left; a retry schedules the next one only
    // after its request settles.
    flushTimers: async () => {
      for (let round = 0; round < 20 && timers.length; round += 1) {
        while (timers.length) timers.shift().fn();
        await settle();
        await settle();
      }
    },
  };
}

// Values built inside the VM carry its realm's prototypes.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a reading addressed by the live id lands on the durable session the view shows', async () => {
  const p = panel({ answers: { 'session.context_breakdown': breakdownFor(194_000), 'session.usage': { context_used: 194_000, context_max: 500_000, compressions: 0 } } });
  p.open('stored-A', 'live-A1');
  assert.equal(p.run('refreshSessionContextTelemetry()'), true);
  await settle();
  const requested = p.client.calls.map((call) => [call.method, call.params.session_id]);
  same(requested, [['session.usage', 'live-A1'], ['session.context_breakdown', 'live-A1']], 'RPCs address the live runtime');
  assert.equal(p.entry('stored-A').breakdown.usedTokens, 194_000);
  assert.equal(p.entry('live-A1'), null, 'nothing is filed under the live id');
  assert.equal(p.entry('stored-A').usage.compressions, 0);
});

test('switching sessions shows each one\'s own context at once, and A-B-A returns A as it was left', async () => {
  const p = panel({ answers: { 'session.context_breakdown': (params) => breakdownFor(params.session_id.startsWith('stored-B') ? 60_000 : 194_000) } });
  p.open('stored-A', 'live-A1');
  p.run('refreshSessionContextTelemetry()');
  await settle();
  p.open('stored-B', 'stored-B-live');
  // B has never been measured: the view must not show A's numbers under B's name.
  assert.equal(p.run('viewedSessionContextEntry()'), null);
  p.run('refreshSessionContextTelemetry()');
  await settle();
  assert.equal(p.run('viewedSessionContextEntry()').breakdown.usedTokens, 60_000);
  // A 1 Hz tick for A arrives while B is on screen: it updates A only.
  p.client.emit('session.usage', 'live-A1', { usage: { context_used: 200_000, context_max: 500_000 } });
  assert.equal(p.entry('stored-B').usage, null);
  // Back to A on a new socket session: its last reading is there before any request.
  const callsBefore = p.client.calls.length;
  p.open('stored-A', 'live-A2');
  assert.equal(p.run('viewedSessionContextEntry()').usage.usedTokens, 200_000);
  assert.equal(p.run('viewedSessionContextEntry()').breakdown.categories.length, 3, 'usage ticks kept the categories');
  assert.equal(p.client.calls.length, callsBefore);
  assert.equal(p.run('currentSessionContextUsedTokens()'), 200_000, 'the model-switch guard reads the same number');
});

test('context readings survive a panel reload', async () => {
  const p = panel({ answers: { 'session.context_breakdown': breakdownFor(194_000), 'session.usage': { context_used: 196_000, context_max: 500_000, compressions: 2 } } });
  p.open('stored-A', 'live-A1');
  p.run('refreshSessionContextTelemetry()');
  await settle();
  await p.flushTimers(); // the debounced persist
  assert.ok(p.storage.hermesBrowserSessionContext, 'the store is written to storage.local');

  const reloaded = panel();
  Object.assign(reloaded.storage, p.storage);
  await reloaded.run('loadSessionContextStore()');
  reloaded.open('stored-A', 'live-A9');
  const entry = reloaded.run('viewedSessionContextEntry()');
  assert.equal(entry.usage.compressions, 2);
  assert.equal(entry.breakdown.categories.length, 3);
});

test('a zeroed or failed breakdown retries on the bounded ladder and keeps the last good reading', async () => {
  let attempt = 0;
  const p = panel({
    answers: {
      'session.context_breakdown': () => {
        attempt += 1;
        if (attempt === 1) return breakdownFor(194_000);
        if (attempt === 2) return { categories: [], context_max: 0, context_used: 0 };
        throw new Error('rebinding');
      },
    },
  });
  p.open('stored-A', 'live-A1');
  p.run('refreshSessionContextTelemetry()');
  await settle();
  p.run('refreshSessionContextTelemetry({ force: true })');
  await settle();
  assert.equal(p.entry('stored-A').breakdown.usedTokens, 194_000, 'the zeroed answer is not stored');
  assert.deepEqual(p.timers.map((timer) => timer.ms).filter((ms) => ms !== 750), [1_000], 'the first retry waits 1 s (750 ms is the persist)');
  await p.flushTimers();
  assert.equal(attempt, 5, 'one try plus three retries, then the ladder stops');
  assert.equal(p.entry('stored-A').breakdown.usedTokens, 194_000);
});

test('a finished turn re-measures the viewed session; other sessions are left alone', async () => {
  const p = panel({ answers: { 'session.context_breakdown': breakdownFor(194_000) } });
  p.open('stored-A', 'live-A1');
  p.client.emit('message.complete', 'live-A1', { text: 'done', usage: { context_used: 210_000, context_max: 500_000, compressions: 1 } });
  assert.equal(p.entry('stored-A').usage.usedTokens, 210_000);
  await p.flushTimers();
  assert.ok(p.client.calls.some((call) => call.method === 'session.context_breakdown' && call.params.session_id === 'live-A1'));
  const before = p.client.calls.length;
  p.client.emit('message.complete', 'live-unknown', { text: 'elsewhere', usage: { context_used: 1, context_max: 2 } });
  await p.flushTimers();
  assert.equal(p.client.calls.length, before);
  assert.equal(p.entry('live-unknown').usage.usedTokens, 1, 'an unmapped id is kept under its own key, never under the viewed session');
});

test('opening a live session with five subagents puts all five in the dock, and steer reaches the live runtime', async () => {
  const children = Array.from({ length: 5 }, (_, index) => ({
    subagent_id: `sa-${index + 1}`, parent_id: null, depth: 1, goal: `Task ${index + 1}`, delegation_id: `d-${index + 1}`,
    model: 'gpt-5.5', started_at: 1_700_000_000 + index, status: 'running', tool_count: index, last_tool: 'terminal', accepting_steer: true,
  }));
  const p = panel({ answers: { 'subagent.list': { subagents: children, delegations: [] }, 'subagent.steer': { status: 'queued' } } });
  p.open('stored-A', 'live-A1');
  await p.run("hydrateSubagentSnapshot(activeDashboardWsConnection.client, 'live-A1')");
  same(p.client.calls.at(-1), { method: 'subagent.list', params: { session_id: 'live-A1' } });
  const live = p.run('activeSubagentView(currentSubagentItems())');
  assert.equal(live.length, 5);
  same([...live].map((row) => row.goal), ['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5']);

  // A child spawned before the resume still reports the owner's older live id.
  p.run('rememberLiveSessionAlias("live-A0", "stored-A")');
  p.run(`ingestSubagentGatewayEvent({ type: 'subagent.tool', sessionId: 'live-A0', payload: { subagent_id: 'sa-3', goal: 'Task 3', tool_name: 'web_search', tool_preview: 'hermes', status: 'running' } })`);
  assert.equal(p.run('currentSubagentItems().find((row) => row.id === "sa-3").currentTool'), 'Web Search("hermes")');
  // An event for a session the panel is not showing never enters this dock.
  p.run(`ingestSubagentGatewayEvent({ type: 'subagent.start', sessionId: 'live-other', payload: { subagent_id: 'x', goal: 'Elsewhere' } })`);
  assert.equal(p.run('activeSubagentView(currentSubagentItems()).length'), 5);

  p.run("subagentSelectedId = 'sa-2'");
  await p.run("runSelectedSubagentControl('steer', 'focus on the tests')");
  same(p.client.calls.at(-1), {
    method: 'subagent.steer',
    params: { session_id: 'stored-A-live-2', subagent_id: 'sa-2', text: 'focus on the tests' },
  }, 'steer resumes the durable session and addresses its fresh live id');
  assert.equal(p.run('subagentControlError'), '');
});

test('while subagents run the roster is re-read from the gateway, and the poll stops when they finish', async () => {
  let roster = [{ subagent_id: 'sa-1', goal: 'Task 1', status: 'running', started_at: 1 }];
  const p = panel({ answers: { 'subagent.list': () => ({ subagents: roster }) } });
  p.open('stored-A', 'live-A1');
  await p.run("hydrateSubagentSnapshot(activeDashboardWsConnection.client, 'live-A1')");
  p.run('scheduleSubagentRosterPoll(1)');
  same(p.timers.map((timer) => timer.ms), [3_000]);
  roster = [];
  await p.flushTimers();
  assert.equal(p.client.calls.filter((call) => call.method === 'subagent.list').length, 2);
  assert.equal(p.run('activeSubagentView(currentSubagentItems()).length'), 0, 'a child the gateway no longer lists leaves the dock');
  p.run('scheduleSubagentRosterPoll(0)');
  assert.equal(p.timers.length, 0);
});

test('openHermesSession starts the subagent and context restore before it waits for history', () => {
  const open = between('async function openHermesSession(', '\n// Follow a session the gateway is still running.');
  const hydrate = open.indexOf('hydrateSubagentSnapshot(activeDashboardWsConnection.client, liveSessionId)');
  const refresh = open.indexOf('refreshSessionContextTelemetry()');
  const history = open.indexOf('await loadSessionMessages(liveSessionId');
  assert.ok(hydrate > 0 && refresh > 0 && history > 0);
  assert.ok(hydrate < history && refresh < history, 'the restore runs alongside the history load, not after it');
  assert.match(open, /rememberLiveSessionAlias\(liveId, storedId\)/);
  assert.match(open, /if \(viewedSessionContextEntry\(\)\) renderContextWindow\(\);/, 'a known reading paints before the rest loads');
});

test('the composer popover holds only the context card; the long readout lives in Settings', async () => {
  const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const popover = html.match(/<section id="contextPopover"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(popover, /id="contextUsageCard" class="context-usage-card" data-compact="true"/);
  for (const id of ['contextRuntimeBreakdown', 'contextBreakdown', 'contextUsageDetail']) {
    assert.doesNotMatch(popover, new RegExp(`id="${id}"`), `${id} is not in the popover`);
  }
  assert.doesNotMatch(popover, /<dl\b/, 'no definition lists to scroll through');
  const details = html.match(/<details class="context-window-details">[\s\S]*?<\/details>/)?.[0] || '';
  assert.match(details, /id="settingsContextRuntime"/);
  assert.match(details, /id="settingsContextPayload"/);
  const card = between('function renderContextUsageCard(', '\nobserveComposerPopovers();');
  assert.match(card, /insight\.tone !== 'info' \|\| insight\.id === 'no-breakdown'/, 'the compact card keeps warnings and the no-breakdown note only');
});

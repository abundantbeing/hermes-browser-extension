import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installGroupLifecycleHarness } from './helpers/group-lifecycle-harness.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const loadSource = source.slice(source.indexOf('async function loadProfiles('), source.indexOf('\nfunction profileSwitchDisplayName('));
function harness({ fail = false, profiles = [{ name: 'default' }], previous = [], availableProfiles = [], groupChats = [{ id: 'existing-room' }], gatewayMode = 'local-api', activeGroupState = null, settingsOverrides = {} } = {}) {
  const writes = [];
  const statuses = [];
  const connectionRequests = [];
  const rosterSyncCalls = [];
  let currentGatewayMode = gatewayMode;
  const bodyClasses = new Set();
  const bodyClassList = {
    add(value) { bodyClasses.add(value); },
    remove(value) { this.removed = value; bodyClasses.delete(value); },
    contains(value) { return bodyClasses.has(value); },
  };
  const uiRenders = { groupThreads: 0, messages: 0, sessionLabel: 0, profileIndicator: 0, botModeView: '' };
  const context = {
    settings: { activeProfile: 'default', gatewayUrl: 'http://127.0.0.1:8642', gatewayMode, ...settingsOverrides },
    botModeRosterGeneration: 0, botModeRoster: previous, botModeGroupChats: groupChats,
    activeGroupGeneration: 0,
    activeGroupProjection: activeGroupState?.projection || null,
    activeGroupRuntime: activeGroupState?.runtime || null,
    activeGroupMessages: activeGroupState?.messages || [],
    activeGroupDisplayEvents: [],
    roomEventStore: {},
    readRoomDisplayEvents: () => [],
    activeGroupAbortController: activeGroupState?.abortController || null,
    activeGroupThreadId: activeGroupState?.threadId || '',
    activeGroupPendingNewThread: activeGroupState?.pendingNewThread === true,
    activeGroupExpandedThreads: new Set(activeGroupState?.expandedThreads || []),
    activeGroupTypingMembers: new Map(activeGroupState?.typingMembers || []),
    activeConversationTransport: activeGroupState?.transport || 'rest',
    activeDashboardWsConnection: activeGroupState?.dashboardConnection || null,
    messages: activeGroupState?.messages || [],
    availableProfiles, botModeRosterNote: '', rosterRetryCount: 0,
    profileRichRosterPromise: null, profileRichRosterAllowsTrust: false,
    desktopDashboardUrl: '', botModeRemoteAvatarCache: new Map(),
    els: {
      botModePanel: { hidden: true },
      botModeButton: { setAttribute(name, value) { this[name] = value; } },
      botChatIntro: { hidden: false },
      input: { value: '', focus() {} },
    },
    document: { body: { classList: bodyClassList } },
    setBotModeView(view) { uiRenders.botModeView = view; },
    WS_METHODS: { profilesList: 'profiles.list' },
    normalizeGatewayUrl: (url) => url,
    ensureProfileWsConnection: async () => {
      connectionRequests.push('ensureProfileWsConnection');
      if (fail) throw new Error('dashboard-unavailable');
      return { baseUrl: 'http://127.0.0.1:43210', client: { request: async () => ({ profiles }) } };
    },
    splitBotRosterRows: (payload) => ({ agents: payload.profiles, groupChats: [{ id: 'real-room' }] }),
    botProfileRowsToHermesProfiles: (rows) => rows,
    adoptSyncedGroupChats: (rows, options = {}) => {
      rosterSyncCalls.push({ rows, options });
      const pendingLocal = options.authoritative
        ? context.botModeGroupChats.filter((row) => String(row?.id || '').startsWith('browser-room-'))
        : [];
      context.botModeGroupChats = options.authoritative ? [...rows, ...pendingLocal] : rows;
    },
    writeLastKnownRoster: async (value) => { writes.push(value); },
    readLastKnownRoster: async () => ({ agents: [], groupChats: [] }),
    renderProfiles() {}, renderBotModeRoster() {}, renderBotModeGroupChats() {},
    renderGroupThreadStrip() { uiRenders.groupThreads += 1; },
    renderMessagesFromStorage() { uiRenders.messages += 1; },
    updateSessionLabel() { uiRenders.sessionLabel += 1; },
    renderActiveProfileIndicator() { uiRenders.profileIndicator += 1; },
    resetActiveGroupTypingIndicator() { context.activeGroupTypingMembers.clear(); },
    loadSessions: async () => {}, setStatus: (...args) => statuses.push(args),
    scheduleRosterRetry() {}, isRemoteMode: () => currentGatewayMode !== 'local-api', isRemoteWsMode: () => currentGatewayMode === 'remote-dashboard',
    activeRunControl: null, sending: false, BOT_HISTORY_PAGE_SIZE: 40,
    markRunTerminal: (control) => control,
    groupProjectionMessagesForDisplay: (row) => row.messages || [],
    groupRuntimeMembers: (row) => row.members || [],
    groupProjectionEntryFromDisplayMessage: (message) => message,
    updateActiveGroupActivity() {}, captureTaskToolEvent: async () => {},
    persistActiveGroupProjection: async () => {},
    ensureActiveDashboardWsConnection: async () => ({ baseUrl: 'http://127.0.0.1:43210', client: {} }),
    ensureDesktopDashboardUrl: async () => '',
    fetchRosterFromGateway: async () => ({ profiles: [{ name: 'default' }] }),
    discoverRosterViaGatewayTab: async () => ({ ok: false }),
    retainRosterAfterFailedDiscovery: () => ({ keep: false }),
    hermesGatewayKey: () => '', fetch: async () => { throw new Error('not expected'); },
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; },
    clearTimeout, console,
  };
  vm.createContext(context);
  installGroupLifecycleHarness(context, source);
  vm.runInContext(`${loadSource}\nthis.run = loadProfiles;`, context);
  return {
    context, writes, statuses, connectionRequests, rosterSyncCalls, uiRenders,
    setGatewayMode(mode) {
      currentGatewayMode = mode;
      context.settings.gatewayMode = mode;
    },
  };
}

test('failed rich discovery cannot replace or cache bare health names', async () => {
  const previous = [{ name: 'default', title: 'Custom title', avatar: 'custom-image' }];
  const { context, writes } = harness({ fail: true, previous });
  const result = await context.run();
  assert.equal(result.status, 'degraded');
  assert.equal(context.botModeRoster, previous);
  assert.equal(context.botModeGroupChats[0].id, 'existing-room');
  assert.equal(writes.length, 0);
  assert.ok(context.botModeRosterNote);
});

test('one-profile rich roster is complete and cached exactly once', async () => {
  const { context, writes } = harness();
  const result = await context.run();
  assert.equal(result.status, 'ready');
  assert.equal(result.detail, '1 PROFILE LOADED.');
  assert.equal(context.botModeRoster.length, 1);
  assert.equal(context.botModeGroupChats[0].id, 'real-room');
  assert.equal(writes.length, 1);
});

test('a successful empty Dashboard roster is ready and reports zero profiles', async () => {
  const { context, writes, uiRenders } = harness({ profiles: [] });
  const result = await context.run();

  assert.equal(result.status, 'ready');
  assert.equal(result.detail, '0 PROFILES LOADED.');
  assert.equal(context.botModeRoster.length, 0);
  assert.equal(context.availableProfiles.length, 0);
  assert.equal(writes.length, 1);
  assert.ok(uiRenders.profileIndicator > 0);
});

test('Remote API-only mode clears stale Dashboard roster state while preserving local draft rooms', async () => {
  const previous = [{ name: 'old-agent', sourceId: 'old-dashboard' }];
  const localRoom = { id: 'browser-room-local-draft' };
  const { context, writes, connectionRequests, rosterSyncCalls } = harness({
    gatewayMode: 'remote-api',
    previous,
    availableProfiles: [{ name: 'old-agent', sourceId: 'old-dashboard' }],
    groupChats: [{ id: 'old-room', sourceId: 'old-dashboard' }, localRoom],
  });
  const result = await context.run();

  assert.equal(result.status, 'degraded');
  assert.match(result.detail, /Remote API mode/);
  assert.equal(connectionRequests.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(context.botModeRoster.length, 0);
  assert.equal(context.availableProfiles.length, 0);
  assert.equal(context.botModeGroupChats.some((row) => row.id === 'old-room'), false);
  assert.equal(context.botModeGroupChats.some((row) => row.id === localRoom.id), true);
  assert.equal(rosterSyncCalls.at(-1).rows.length, 0);
  assert.equal(rosterSyncCalls.at(-1).options.authoritative, true);
  assert.equal(rosterSyncCalls.at(-1).options.allowCanonicalFallback, false);
});

test('Remote API-only mode clears a previously active Dashboard group runtime without erasing profile selection', async () => {
  const abortController = { aborted: false, abort() { this.aborted = true; } };
  const activeGroupState = {
    projection: { id: 'old-room', displayName: 'Old room', members: ['old-agent'] },
    runtime: { send() {} },
    messages: [{ role: 'assistant', content: 'stale Dashboard message' }],
    abortController,
    threadId: 'old-thread',
    pendingNewThread: true,
    expandedThreads: ['old-thread'],
    typingMembers: [['old-agent', { roleLabel: 'Old Agent' }]],
    transport: 'dashboard-ws',
    dashboardConnection: { id: 'old-dashboard' },
  };
  const { context, uiRenders } = harness({
    gatewayMode: 'remote-api',
    activeGroupState,
    settingsOverrides: { activeProfile: 'old-agent', botModeSelectedProfile: 'old-agent', botModeEnabled: true },
  });
  const result = await context.run();

  assert.equal(result.status, 'degraded');
  assert.equal(abortController.aborted, true);
  assert.equal(context.activeGroupProjection, null);
  assert.equal(context.activeGroupRuntime, null);
  assert.equal(context.activeGroupAbortController, null);
  assert.equal(context.activeGroupMessages.length, 0);
  assert.equal(context.activeGroupThreadId, '');
  assert.equal(context.activeGroupPendingNewThread, false);
  assert.equal(context.activeGroupExpandedThreads.size, 0);
  assert.equal(context.activeGroupTypingMembers.size, 0);
  assert.equal(context.messages.length, 0);
  assert.equal(context.activeConversationTransport, 'rest');
  assert.equal(context.activeDashboardWsConnection, null);
  assert.equal(context.settings.activeProfile, 'old-agent');
  assert.equal(context.settings.botModeSelectedProfile, 'old-agent');
  assert.ok(uiRenders.groupThreads > 0);
  assert.ok(uiRenders.messages > 0);
  assert.ok(uiRenders.sessionLabel > 0);
  assert.equal(uiRenders.botModeView, 'agents');
  assert.equal(context.els.botModePanel.hidden, false);
  assert.equal(context.els.botModeButton['aria-expanded'], 'true');
  assert.equal(context.els.botChatIntro.hidden, true);
  assert.equal(context.document.body.classList.removed, 'bot-mode-engaged');
});

test('late callbacks from a retired Dashboard group runtime cannot repopulate cleared state', async () => {
  const openStart = source.indexOf('async function openBotGroupChat(');
  const openEnd = source.indexOf('\n// Group projections are read from the connected verified roster', openStart);
  const openGroupSource = source.slice(openStart, openEnd);
  const { context, uiRenders, setGatewayMode } = harness({
    gatewayMode: 'local-api',
    settingsOverrides: { botModeEnabled: true },
  });
  let callbacks;
  let activityCalls = 0;
  let persistenceCalls = 0;
  context.createBotGroupRuntime = (options) => {
    callbacks = options;
    return { prepare: async () => ({ ok: true, failures: [] }), send: async () => ({ ok: true }) };
  };
  context.updateActiveGroupActivity = () => { activityCalls += 1; };
  context.persistActiveGroupProjection = async () => { persistenceCalls += 1; };
  vm.runInContext(`${openGroupSource}\nthis.openGroup = openBotGroupChat;`, context);

  const room = { id: 'dashboard-room', roomId: 'dashboard-room', displayName: 'Dashboard room', members: ['agent-a'] };
  assert.equal(await context.openGroup(room), true);
  assert.equal(context.activeGroupProjection, room);
  assert.ok(callbacks);

  setGatewayMode('remote-api');
  assert.equal((await context.run()).status, 'degraded');
  const rendersAfterCleanup = { ...uiRenders };
  await callbacks.onMessage({ role: 'assistant', content: 'late response' });
  await callbacks.onActivity({ kind: 'working', member: 'agent-a' });
  await callbacks.persist([{ role: 'assistant', content: 'late response' }]);

  assert.equal(context.activeGroupProjection, null);
  assert.equal(context.activeGroupRuntime, null);
  assert.equal(context.activeGroupMessages.length, 0);
  assert.equal(context.messages.length, 0);
  assert.equal(activityCalls, 0);
  assert.equal(persistenceCalls, 0);
  assert.deepEqual(uiRenders, rendersAfterCleanup);
});

test('late Dashboard group-roster sync cannot restore rows after Remote API-only cleanup', async () => {
  const syncStart = source.indexOf('async function syncActiveGroupRoomFromGateway(');
  const syncEnd = source.indexOf('\nasync function openBotGroupChat(', syncStart);
  const syncSource = source.slice(syncStart, syncEnd);
  const activeRoom = { id: 'old-room', roomId: 'old-room', displayName: 'Old room', messages: [] };
  const { context, setGatewayMode } = harness({
    gatewayMode: 'local-api',
    groupChats: [{ id: 'old-room', sourceId: 'old-dashboard' }],
    activeGroupState: { projection: activeRoom, runtime: { prepare() {} }, messages: [{ role: 'user', content: 'old' }] },
  });
  let resolveRoster;
  context.ensureProfileWsConnection = async () => ({
    client: { request: () => new Promise((resolve) => { resolveRoster = resolve; }) },
  });
  vm.runInContext(`${syncSource}\nthis.sync = syncActiveGroupRoomFromGateway;`, context);

  const pendingSync = context.sync();
  for (let attempt = 0; attempt < 5 && !resolveRoster; attempt += 1) await Promise.resolve();
  assert.equal(typeof resolveRoster, 'function');

  setGatewayMode('remote-api');
  await context.run();
  resolveRoster({ profiles: [{ name: 'default' }] });
  await pendingSync;

  assert.equal(context.activeGroupProjection, null);
  assert.equal(context.activeGroupMessages.length, 0);
  assert.equal(context.messages.length, 0);
  assert.equal(context.botModeGroupChats.some((row) => row.id === 'real-room'), false);
});

test('Remote API-only group cleanup cannot let an aborted in-flight send restore stale group messages', async () => {
  const start = source.indexOf('async function sendActiveGroupMessage(');
  const end = source.indexOf('\n// Desktop-parity threads strip', start);
  const sendSource = source.slice(start, end);
  const statuses = [];
  let resolveTurn;
  const context = {
    activeGroupProjection: { id: 'old-room', roomId: 'old-room', displayName: 'Old room' },
    activeGroupRuntime: { send: () => new Promise((resolve) => { resolveTurn = resolve; }) },
    activeGroupGeneration: 1,
    activeGroupMessages: [{ role: 'user', content: 'old group prompt' }],
    activeGroupAbortController: null,
    activeGroupPresence: { phase: 'idle' },
    activeGroupDisplayEvents: [],
    activeGroupThreadId: '',
    activeGroupPendingNewThread: false,
    activeGroupExpandedThreads: new Set(),
    activeGroupTypingMembers: new Map(),
    messages: [{ role: 'user', content: 'old group prompt' }],
    sending: false,
    AbortController: class {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; }
    },
    els: { input: { value: '' } },
    groupRuntimeMembers: () => [{ name: 'old-agent' }],
    renderAttachments() {},
    updateComposerBusyState() {},
    renderGroupThreadStrip() {},
    renderMessagesFromStorage() {},
    updateSessionLabel() {},
    renderActiveProfileIndicator() {},
    resetActiveGroupTypingIndicator() {},
    groupProjectionEntryFromDisplayMessage: (message) => message,
    setStatus: (...args) => statuses.push(args),
    contextScope: { mode: 'chat-only' },
    settings: { gatewayUrl: 'http://127.0.0.1:8642' },
    browserApi: {},
    effectiveContextGate: (scope) => ({ allowed: false, scope: { mode: 'chat-only' } }),
    prepareBotBrowserTurn: async () => ({ browserContext: { enabled: false }, screenshotAttachments: [] }),
    collectBotPageContext: async () => ({ activeTab: null, tabs: [], pageContext: null }),
  };
  vm.createContext(context);
  installGroupLifecycleHarness(context, source);
  vm.runInContext(`${sendSource}\nthis.run = sendActiveGroupMessage;`, context);
  const pending = context.run('new message');
  for (let attempt = 0; attempt < 5 && !resolveTurn; attempt += 1) await Promise.resolve();
  const abortController = context.activeGroupAbortController;
  assert.ok(abortController);
  abortController.abort();
  context.activeGroupProjection = null;
  context.activeGroupRuntime = null;
  context.activeGroupMessages = [];
  context.messages = [];
  resolveTurn({ ok: true, failures: [], messages: [{ role: 'assistant', content: 'late stale reply' }] });
  const result = await pending;

  assert.equal(result, false);
  assert.equal(context.messages.length, 0);
  assert.equal(context.activeGroupMessages.length, 0);
  assert.equal(statuses.some((status) => status[1] === 'Group message sent'), false);
});

test('an empty authoritative roster hides the stale active-profile indicator but preserves explicit selection', () => {
  const start = source.indexOf('function renderActiveProfileIndicator()');
  const end = source.indexOf('\n  function closeProfileSwitchMenu()', start);
  const indicatorSource = source.slice(start, end);
  const indicator = {
    hidden: false,
    style: {},
    classList: { add() {}, remove() {} },
    replaceChildren() {},
    removeAttribute() {},
    setAttribute() {},
    append() {},
  };
  const closedMenus = { count: 0 };
  const context = {
    els: { activeProfileIndicator: indicator, composerActions: null },
    activeGroupProjection: null,
    settings: { activeProfile: 'old-agent', botModeSelectedProfile: 'old-agent', botModeEnabled: true },
    botModeRoster: [],
    botModeRosterNote: '',
    document: { body: { classList: { contains: () => true } } },
    botProfileDisplayName: (row) => row.profileName,
    appendBotModeAvatar: () => {},
    remoteAvatarImageOf: () => '',
    hydrateBotModeRemoteAvatar() {},
    groupRuntimeMembers: () => [],
    closeProfileSwitchMenu: () => { closedMenus.count += 1; },
  };
  vm.createContext(context);
  vm.runInContext(`${indicatorSource}\nthis.run = renderActiveProfileIndicator;`, context);
  context.run();

  assert.equal(indicator.hidden, true);
  assert.equal(closedMenus.count, 1);
  assert.equal(context.settings.activeProfile, 'old-agent');
  assert.equal(context.settings.botModeSelectedProfile, 'old-agent');
});

test('Remote API-only mode refuses to open retained group rooms through Dashboard transport', async () => {
  const start = source.indexOf('async function openBotGroupChat(');
  const end = source.indexOf('\n// Group projections are read from the connected verified roster', start);
  const openGroupSource = source.slice(start, end);
  const dashboardRequests = [];
  const statuses = [];
  const context = {
    isRemoteMode: () => true,
    isRemoteWsMode: () => false,
    sending: false,
    activeRunControl: null,
    activeGroupProjection: null,
    activeGroupRuntime: null,
    activeGroupMessages: [],
    activeGroupThreadId: '',
    activeGroupPendingNewThread: false,
    activeGroupExpandedThreads: new Set(),
    messages: [],
    activeConversationTransport: 'rest',
    botHistoryVisibleCount: 0,
    BOT_HISTORY_PAGE_SIZE: 40,
    groupProjectionMessagesForDisplay: () => [],
    resetActiveGroupTypingIndicator() {},
    renderGroupThreadStrip() {},
    renderMessagesFromStorage() {},
    updateSessionLabel() {},
    document: { body: { classList: { add() {} } } },
    els: { botModePanel: {}, botModeButton: { setAttribute() {} }, input: { focus() {} } },
    ensureActiveDashboardWsConnection: async () => {
      dashboardRequests.push('requested');
      throw new Error('unexpected Dashboard connection');
    },
    setStatus: (...args) => statuses.push(args),
  };
  vm.createContext(context);
  vm.runInContext(`${openGroupSource}\nthis.run = openBotGroupChat;`, context);
  const result = await context.run({ id: 'browser-room-local-draft' });

  assert.equal(result, false);
  assert.equal(dashboardRequests.length, 0);
  assert.equal(statuses[0]?.[1], 'Group chat unavailable');
  assert.match(statuses[0]?.[2] || '', /Hermes Dashboard/i);
  assert.equal(context.activeGroupProjection, null);
});

test('legacy local bootstrap connects without requiring an unrelated signed-in tab', async () => {
  const wsSource = source.slice(source.indexOf('async function ensureProfileWsConnection('), source.indexOf('\nfunction usesDashboardWsChatTransport('));
  const client = { readyState: 1, on() {}, connect: async () => {}, close() {} };
  const context = {
    isRemoteWsMode: () => false, desktopDashboardUrl: 'http://127.0.0.1:43210',
    normalizeGatewayUrl: (url) => url, profileConnectionKey: () => 'profile-route',
    profileWsConnection: null, trustedDashboardTabId: null,
    dashboardTicketOriginMatches: () => false,
    dashboardFetch: async () => ({ ok: true, text: async () => 'legacy bootstrap' }),
    extractDashboardSessionToken: () => 'fixture-bootstrap',
    requestDashboardOriginTrust: async () => { throw new Error('no-dashboard-tab'); },
    settings: {}, createGatewayClient: () => client, WebSocket: {},
    buildDashboardWsUrlWithCredential: () => 'ws://localhost/fixture',
    buildDashboardWsUrl: () => 'ws://localhost/fixture',
  };
  vm.createContext(context);
  vm.runInContext(`${wsSource}\nthis.run = ensureProfileWsConnection;`, context);
  const connection = await context.run({ allowDashboardTrust: true });
  assert.equal(connection.client, client);
});

test('dashboard WebSocket bootstrap uses the same worker transport as discovery', () => {
  const wsSource = source.slice(source.indexOf('async function ensureProfileWsConnection('), source.indexOf('\nfunction usesDashboardWsChatTransport('));
  assert.doesNotMatch(wsSource, /await fetch\((?:baseUrl|freshBase)/);
  assert.match(wsSource, /await dashboardFetch\(baseUrl/);
});

// A `sessions.changed` roster sync re-parses the room and therefore REPLACES
// the activeGroupProjection object for the SAME open room. The room's runtime
// callbacks are bound to the generation/runtime token, not to that object's
// identity, so an in-place sync must not freeze the open room: member replies
// still render and the Dashboard projection still persists.
test('an in-place roster sync keeps the open room runtime callbacks live', async () => {
  const start = source.indexOf('async function openBotGroupChat(');
  const end = source.indexOf('\n// Group projections are read from the connected verified roster', start);
  const openGroupSource = source.slice(start, end);
  const row = {
    id: 'room-1',
    roomId: 'room-1',
    displayName: 'Room One',
    messages: [],
    members: [{ name: 'alpha' }, { name: 'beta' }],
  };
  const renders = { messages: 0 };
  const captured = [];
  const persisted = [];
  const context = {
    isRemoteMode: () => false,
    isRemoteWsMode: () => false,
    sending: false,
    activeRunControl: null,
    markRunTerminal: (control) => control,
    activeGroupGeneration: 0,
    activeGroupProjection: null,
    activeGroupRuntime: null,
    activeGroupMessages: [],
    activeGroupPresence: { phase: 'idle' },
    activeGroupLiveMessage: null,
    activeGroupDisplayEvents: [],
    roomEventStore: {},
    readRoomDisplayEvents: () => [],
    activeGroupThreadId: '',
    activeGroupPendingNewThread: false,
    activeGroupExpandedThreads: new Set(),
    activeGroupTypingMembers: new Map(),
    activeGroupAbortController: null,
    activeConversationTransport: 'rest',
    botHistoryVisibleCount: 0,
    BOT_HISTORY_PAGE_SIZE: 40,
    messages: [],
    document: { body: { classList: { add() {} } } },
    els: { botModePanel: {}, botModeButton: { setAttribute() {} }, input: { focus() {} } },
    ensureActiveDashboardWsConnection: async () => ({ baseUrl: 'http://dash', client: {} }),
    persistGroupProjectionAppend: async (_client, entry) => { persisted.push(entry); },
    groupProjectionMessagesForDisplay: (target) => (target?.messages || []).map((entry) => ({ ...entry })),
    groupRuntimeMembers: (target) => target?.members || [],
    groupProjectionEntryFromDisplayMessage: (message) => ({ ...message }),
    updateActiveGroupActivity() {},
    captureTaskToolEvent: async () => {},
    resetActiveGroupTypingIndicator() {},
    renderGroupThreadStrip() {},
    renderMessagesFromStorage() { renders.messages += 1; },
    updateSessionLabel() {},
    renderActiveProfileIndicator() {},
    setStatus() {},
    createBotGroupRuntime: (handlers) => {
      captured.push(handlers);
      return { prepare: async () => ({ ok: true, failures: [] }) };
    },
  };
  vm.createContext(context);
  installGroupLifecycleHarness(context, source);
  vm.runInContext(`${openGroupSource}\nthis.open = openBotGroupChat;`, context);

  const opened = await context.open(row);
  assert.equal(opened, true);
  assert.equal(captured.length, 1);
  const runtime = captured[0];

  // A real roster sync swaps the projection object for the same room.
  context.activeGroupProjection = { ...row, messages: [] };
  assert.notEqual(context.activeGroupProjection, row);
  assert.equal(context.activeGroupGeneration, 1);
  assert.ok(context.activeGroupRuntime);

  renders.messages = 0;
  await runtime.onMessage({ role: 'assistant', roleLabel: 'Alpha', content: 'reply after sync' });
  assert.equal(renders.messages, 1, 'member replies must still render after an in-place roster sync');

  await runtime.persist([{ role: 'user', content: 'turn' }]);
  assert.equal(persisted.length, 1, 'the Dashboard group projection must still be written after a sync');

  // The message entry must land on the CURRENT projection object, not the
  // pre-sync captured one.
  assert.equal(context.activeGroupProjection.messages.length, 1);
  assert.equal(row.messages.length, 0);
});

// The same identity trap existed in the send path: a roster sync landing
// mid-turn must not silently discard a completed group turn.
test('an in-place roster sync mid-turn does not discard a completed group turn', async () => {
  const start = source.indexOf('async function sendActiveGroupMessage(');
  const end = source.indexOf('\n// Desktop-parity threads strip', start);
  const sendSource = source.slice(start, end);
  const statuses = [];
  let resolveTurn;
  const row = { id: 'room-1', roomId: 'room-1', displayName: 'Room One' };
  const context = {
    activeGroupProjection: row,
    activeGroupRuntime: { send: () => new Promise((resolve) => { resolveTurn = resolve; }) },
    activeGroupGeneration: 1,
    activeGroupMessages: [],
    activeGroupPresence: { phase: 'idle' },
    activeGroupDisplayEvents: [],
    activeGroupAbortController: null,
    activeGroupThreadId: '',
    activeGroupPendingNewThread: false,
    activeGroupExpandedThreads: new Set(),
    activeGroupTypingMembers: new Map(),
    messages: [],
    sending: false,
    AbortController: class {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; }
    },
    els: { input: { value: '' } },
    groupRuntimeMembers: () => [{ name: 'alpha' }, { name: 'beta' }],
    groupProjectionEntryFromDisplayMessage: (message) => message,
    renderAttachments() {},
    updateComposerBusyState() {},
    renderGroupThreadStrip() {},
    renderMessagesFromStorage() {},
    updateSessionLabel() {},
    renderActiveProfileIndicator() {},
    resetActiveGroupTypingIndicator() {},
    setStatus: (...args) => statuses.push(args),
    contextScope: { mode: 'chat-only' },
    settings: { gatewayUrl: 'http://127.0.0.1:8642' },
    browserApi: {},
    effectiveContextGate: (scope) => ({ allowed: false, scope: { mode: 'chat-only' } }),
    prepareBotBrowserTurn: async () => ({ browserContext: { enabled: false }, screenshotAttachments: [] }),
    collectBotPageContext: async () => ({ activeTab: null, tabs: [], pageContext: null }),
  };
  vm.createContext(context);
  installGroupLifecycleHarness(context, source);
  vm.runInContext(`${sendSource}\nthis.run = sendActiveGroupMessage;`, context);

  const pending = context.run('room prompt');
  for (let attempt = 0; attempt < 5 && !resolveTurn; attempt += 1) await Promise.resolve();
  // `sessions.changed` fires while the turn is in flight.
  context.activeGroupProjection = { ...row };
  resolveTurn({ ok: true, failures: [], messages: [{ role: 'assistant', content: 'reply' }] });
  const result = await pending;

  assert.equal(result, true);
  assert.equal(statuses.some((status) => status[1] === 'Group message sent'), true);
});

// Guard the fix itself: liveness must be the generation token, never the
// projection object's identity, or an in-place sync silently freezes the room.
test('group runtime liveness is tracked by generation, not projection identity', () => {
  const start = source.indexOf('async function openBotGroupChat(');
  const end = source.indexOf('\n// Group projections are read from the connected verified roster', start);
  const openGroupSource = source.slice(start, end);
  assert.match(
    openGroupSource,
    /const isCurrentOpen = \(\) => groupGeneration === activeGroupGeneration;/,
    'isCurrentOpen must key on the generation token alone',
  );
  assert.doesNotMatch(
    openGroupSource,
    /const isCurrentOpen = \(\) =>[^;]*activeGroupProjection ===/,
    'isCurrentOpen must not require projection object identity',
  );

  const sendStart = source.indexOf('async function sendActiveGroupMessage(');
  const sendEnd = source.indexOf('\n// Desktop-parity threads strip', sendStart);
  const sendSource = source.slice(sendStart, sendEnd);
  assert.doesNotMatch(
    sendSource,
    /activeGroupProjection !== groupProjection/,
    'the send path must not treat a re-parsed projection as stale',
  );
});

// Every teardown path must still bump the generation, otherwise the
// generation-based guard above would accept callbacks from a retired room.
test('every group teardown path bumps the generation token', () => {
  const teardownAnchors = [
    'async function openBotProfile(',
    'async function leaveBotModeForRegularSession(',
    'async function createHermesBrowserSession(',
    'async function openHermesSession(',
  ];
  for (const anchor of teardownAnchors) {
    const start = source.indexOf(anchor);
    assert.notEqual(start, -1, `missing ${anchor}`);
    const body = source.slice(start, start + 4000);
    const clearIndex = body.indexOf('activeGroupProjection = null;');
    assert.notEqual(clearIndex, -1, `${anchor} does not clear the projection`);
    const bump = body.lastIndexOf('activeGroupGeneration += 1;', clearIndex);
    assert.notEqual(bump, -1, `${anchor} clears the projection without bumping activeGroupGeneration`);
  }
  // The Remote API-only cleanup path too.
  const remoteCleanup = source.slice(
    source.indexOf('async function loadProfiles('),
    source.indexOf('\nfunction profileSwitchDisplayName('),
  );
  assert.match(remoteCleanup, /activeGroupGeneration \+= 1;[\s\S]{0,200}activeGroupProjection = null;/);
});

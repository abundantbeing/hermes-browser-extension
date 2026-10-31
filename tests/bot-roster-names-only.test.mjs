import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import english from '../extension/lib/locales/en.mjs';
import { BOT_CHAT_TITLE, botProfileRowsToHermesProfiles } from '../extension/lib/bot-mode.mjs';
import { buildNamesOnlyRoster, rosterHasNamesOnlyRows } from '../extension/lib/bot-roster-names.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const loadSource = source.slice(source.indexOf('async function loadProfilesFromGatewayRoutes('), source.indexOf('\nasync function loadProfiles('));
const renderSource = source.slice(source.indexOf('function renderBotModeRoster('), source.indexOf('// Bot Mode → Group Chats: dedicated roster'));

const NOTE = english['bot_mode.roster_names_only'];

test('names-only roster rows carry the name, a degraded state and an honest note key', () => {
  const result = buildNamesOnlyRoster({ names: ['default', 'riku', 'default', ' '], sourceId: 'gw' });
  assert.equal(result.state, 'degraded');
  assert.deepEqual(result.rows.map((row) => row.profileName), ['default', 'riku']);
  assert.ok(result.rows.every((row) => row.namesOnly === true));
  assert.equal(result.rows[0].displayName, 'Hermes');
  assert.equal(result.rows[1].displayName, 'Riku');
  assert.equal(result.rows[1].rosterKey, 'gw::riku');
  assert.equal(result.rows[1].hasAvatar, false);
  assert.equal(result.detail, '2 PROFILES LISTED BY NAME.');
  assert.equal(buildNamesOnlyRoster({ names: ['default'] }).detail, '1 PROFILE LISTED BY NAME.');
  assert.equal(english[result.noteKey], NOTE);
  assert.equal(english[result.actionKey], 'Open connection settings');
  assert.equal(rosterHasNamesOnlyRows(result.rows), true);
});

test('a bot the browser already knew in full keeps its details; Bot Chat lookups add preview and recency', () => {
  const known = { profileName: 'riku', displayName: 'Riku the Bold', hasAvatar: true, title: 'Riku the Bold' };
  const result = buildNamesOnlyRoster({
    names: ['riku', 'namine'],
    richRows: [known, { profileName: 'stale', namesOnly: true }],
    bots: [{ name: 'namine', canonical_session: { id: 'bot-1', title: BOT_CHAT_TITLE, preview: 'Hello there', last_active: 1_700_000_000 } }],
    now: 1_700_000_100_000,
  });
  assert.equal(result.rows[0], known);
  assert.equal(result.rows[0].namesOnly, undefined);
  assert.equal(result.rows[1].namesOnly, true);
  assert.equal(result.rows[1].canonical.durableId, 'bot-1');
  assert.equal(result.rows[1].preview, 'Hello there');
});

function loadHarness({ names = ['default', 'riku'], rosterStatus = 404, sessionRows = {}, health = true } = {}) {
  const statuses = [];
  const fetched = [];
  const renders = { roster: 0, profiles: 0 };
  const context = {
    settings: { activeProfile: 'default', gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'test-key' },
    botModeRosterGeneration: 0, botModeRoster: [], botModeGroupChats: [], availableProfiles: [], botModeRosterNote: 'stale', rosterRetryCount: 2,
    els: { botModeSearch: { value: '' } },
    BOT_CHAT_TITLE,
    normalizeGatewayUrl: (url) => url,
    fetchRosterFromGatewayApi: async () => { throw Object.assign(new Error(`gateway-roster-${rosterStatus}`), { status: rosterStatus }); },
    fetchRosterFromGateway: async () => {
      throw Object.assign(new Error('gateway-profiles-degraded'), { metadata: { profileNames: health ? names : [] } });
    },
    readLastKnownRoster: async () => ({ agents: [] }),
    writeLastKnownRoster: async () => { throw new Error('a names-only roster must never be cached as rich'); },
    adoptSyncedGroupChats: () => { throw new Error('a names-only roster carries no rooms'); },
    splitBotRosterRows: () => ({ agents: [], groupChats: [] }),
    botProfileRowsToHermesProfiles,
    buildNamesOnlyRoster,
    hermesClient: {
      fetch: async (path) => {
        fetched.push(path);
        const name = decodeURIComponent(path.match(/^\/p\/([^/]+)\//)?.[1] || '');
        return { ok: true, status: 200, name };
      },
      readJson: async (response) => ({ data: sessionRows[response.name] || [] }),
    },
    renderProfiles() { renders.profiles += 1; },
    renderBotModeRoster() { renders.roster += 1; },
    renderActiveProfileIndicator() {},
    setStatus: (...args) => statuses.push(args),
    t: (key) => english[key] || key,
    AbortSignal,
  };
  vm.createContext(context);
  vm.runInContext(`${loadSource}\nthis.run = loadProfilesFromGatewayRoutes;`, context);
  return { context, statuses, fetched, renders };
}

test('stock gateway with only an API key lists profiles by name, degraded, with an honest note', async () => {
  const { context, statuses, fetched, renders } = loadHarness({
    sessionRows: { riku: [{ id: 'riku-bot-chat', title: 'Bot Chat', preview: 'Last words', last_active: 1_700_000_000 }] },
  });
  const result = await context.run({ quiet: false, generation: 0, gatewayUrl: 'http://127.0.0.1:8642' });
  assert.equal(result.status, 'degraded', 'names only is degraded, never ready');
  assert.equal(result.detail, '2 PROFILES LISTED BY NAME.');
  assert.deepEqual(context.botModeRoster.map((row) => row.profileName), ['default', 'riku']);
  assert.equal(context.availableProfiles.length, 2);
  assert.equal(context.botModeRosterNote, NOTE);
  assert.equal(context.rosterRetryCount, 0);
  assert.ok(renders.roster > 0, 'the Bot Mode roster is repainted with the listed bots');
  assert.equal(context.botModeRoster[1].preview, 'Last words');
  assert.equal(context.botModeRoster[1].canonical.durableId, 'riku-bot-chat');
  assert.equal(statuses.at(-1)[0], 'warn');
  assert.equal(statuses.at(-1)[2], NOTE);
  assert.ok(fetched.every((path) => path.includes('title=Bot%20Chat') && path.includes('include_hidden=true')), 'Bot Chats are looked up over the REST session list');
  assert.notEqual(result.detail, '2 PROFILES LOADED.');
});

test('no confirmed profile names still falls through so the dashboard path can run', async () => {
  const { context } = loadHarness({ health: false });
  const result = await context.run({ quiet: true, generation: 0, gatewayUrl: 'http://127.0.0.1:8642' });
  assert.equal(result, null);
  assert.equal(context.botModeRoster.length, 0);
});

test('a superseded sync leaves the roster alone', async () => {
  const { context } = loadHarness();
  const pending = context.run({ quiet: true, generation: 0, gatewayUrl: 'http://127.0.0.1:8642' });
  context.botModeRosterGeneration = 5;
  const result = await pending;
  assert.equal(result.status, 'skipped');
  assert.equal(context.botModeRoster.length, 0);
});

function renderHarness({ roster, note }) {
  const { document } = parseHTML('<div id="botModeRoster"></div><button id="botModeButton"></button><div id="botModePanel"></div>');
  const calls = { settings: [], opened: [] };
  const context = {
    document,
    settings: { botModeEnabled: true, botModeDisplayDensity: 'comfortable' },
    botModeRoster: roster,
    botModeRosterNote: note,
    els: {
      botModeRoster: document.getElementById('botModeRoster'),
      botModeButton: document.getElementById('botModeButton'),
      botModePanel: document.getElementById('botModePanel'),
      botModeSettingsStatus: null,
      botModeStatus: document.createElement('span'),
    },
    botProfileDisplayName: (row) => row.displayName,
    appendBotModeAvatar() {},
    remoteAvatarImageOf: () => '',
    hydrateBotModeRemoteAvatar() {},
    openBotProfile: async (row) => { calls.opened.push(row.profileName); },
    syncBotModeFooterState() {},
    rosterHasNamesOnlyRows,
    openSettingsDialog: (arg) => calls.settings.push(arg),
    t: (key) => english[key] || key,
  };
  vm.createContext(context);
  vm.runInContext(`${renderSource}\nthis.render = renderBotModeRoster;`, context);
  return { context, calls, host: context.els.botModeRoster };
}

test('Bot Mode shows names-only bots with the note and a way to fix it', () => {
  const roster = buildNamesOnlyRoster({ names: ['default', 'riku'] }).rows;
  const { context, host, calls } = renderHarness({ roster, note: NOTE });
  context.render('');
  assert.equal(host.querySelectorAll('.bot-mode-row').length, 2, 'the bots are listed, not "No verified Hermes profiles"');
  assert.equal(host.textContent.includes('No verified Hermes profiles'), false);
  assert.equal(host.querySelector('.bot-mode-empty-note').textContent, NOTE);
  const action = host.querySelector('.bot-mode-roster-note-action');
  assert.equal(action.textContent, 'Open connection settings');
  action.dispatchEvent(new context.document.defaultView.Event('click'));
  assert.equal(JSON.stringify(calls.settings), JSON.stringify([{ pane: 'connections' }]));
  host.querySelector('.bot-mode-row').dispatchEvent(new context.document.defaultView.Event('click'));
  assert.equal(calls.opened.join(), 'default', 'a name-only row still opens its Bot Chat');
  assert.equal(context.els.botModeStatus.textContent, '2 agents · current connected Hermes instance');
});

test('an empty roster keeps its empty state and its reason, with no settings button', () => {
  const { context, host } = renderHarness({ roster: [], note: 'Reason it is empty.' });
  context.render('');
  assert.equal(host.querySelector('.bot-mode-empty').textContent, 'No verified Hermes profiles are available.');
  assert.equal(host.querySelector('.bot-mode-empty-note').textContent, 'Reason it is empty.');
  assert.equal(host.querySelector('.bot-mode-roster-note-action'), null);
});

test('a full roster shows no names-only note', () => {
  const rows = buildNamesOnlyRoster({ names: ['default'] }).rows.map((row) => ({ ...row, namesOnly: undefined }));
  const { context, host } = renderHarness({ roster: rows, note: '' });
  context.render('');
  assert.equal(host.querySelector('.bot-mode-empty-note'), null);
  assert.equal(host.querySelector('.bot-mode-roster-note-action'), null);
});

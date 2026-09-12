import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { WS_METHODS } from '../extension/lib/gateway-ws.mjs';
import {
  dashboardSessionUrl,
  renameSessionInPage,
  renameSessionViaTab,
} from '../extension/lib/dashboard-bridge.mjs';

const read = (path) => readFileSync(new URL(`../extension/${path}`, import.meta.url), 'utf8');

// Top-level function body by the repo's formatting convention (bodies close
// with a line that is exactly `}` at column 0).
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return '';
  const end = source.indexOf('\n}', start);
  return end === -1 ? source.slice(start) : source.slice(start, end + 2);
}

test('gateway client exposes the session.title rename RPC Desktop parity requires', () => {
  assert.equal(WS_METHODS.sessionTitle, 'session.title');
});

test('sidepanel rename flow has no native prompt and renders an in-panel editor', () => {
  const source = read('sidepanel.js');
  const css = read('sidepanel.css');

  assert.doesNotMatch(source, /promptRenameSession/);
  assert.doesNotMatch(source, /Remote dashboard rename RPC is not available yet/);
  for (const name of [
    'openSessionRenameEditor',
    'renderSessionRenameEditor',
    'submitSessionRename',
    'applySessionTitleLocally',
    'renameHermesSessionTitle',
    'renameSessionViaGatewayRpc',
  ]) {
    const body = functionBody(source, name);
    assert.ok(body.length > 0, `${name} must exist`);
    assert.doesNotMatch(body, /window\.prompt/, `${name} must not open a native prompt`);
  }

  // Editor anatomy: input + Save/Cancel, form submit (Enter), Escape cancel, focus.
  assert.match(source, /form\.className = 'session-rename-editor';/);
  assert.match(source, /input\.className = 'session-rename-input';/);
  assert.match(source, /save\.type = 'submit';/);
  assert.match(source, /save\.textContent = translateUiText\('Save'\);/);
  assert.match(source, /cancel\.textContent = translateUiText\('Cancel'\);/);
  assert.match(source, /form\.addEventListener\('submit', \(event\) => \{/);
  assert.match(source, /input\.addEventListener\('keydown', \(event\) => \{[\s\S]{0,140}event\.key === 'Escape'[\s\S]{0,140}closeSessionRenameEditor\(\)/);
  assert.match(source, /input\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /status\.setAttribute\('role', 'status'\)/);

  // The editor replaces the row in place; the session menu renders it.
  assert.match(source, /if \(isSessionRenameEditorTarget\(session\)\) \{[\s\S]{0,160}renderSessionRenameEditor\(row, session\)/);
  assert.match(source, /openSessionRenameEditor\(session\)/);
  // Closing the panel cancels an open edit.
  assert.match(source, /els\.sessionMenu\.hidden = true;[\s\S]{0,220}sessionRenameEditor = null;/);

  assert.match(css, /\.session-rename-editor \{/);
  assert.match(css, /\.session-rename-input \{/);
  assert.match(css, /\.session-rename-status \{/);
  assert.match(css, /\.session-option-row\.renaming \{/);
});

test('sidepanel renames through the session.title RPC with exact params, then REST fallbacks', () => {
  const source = read('sidepanel.js');

  const liveId = functionBody(source, 'sessionRenameRpcLiveId');
  assert.match(liveId, /connection\.wsSessionId/);
  assert.match(liveId, /connection\.wsStoredSessionId/);

  const rpc = functionBody(source, 'renameSessionViaGatewayRpc');
  assert.match(rpc, /connection\.client\.request\(WS_METHODS\.sessionTitle, \{ session_id: liveId, title \}\)/);

  const rest = functionBody(source, 'renameSessionViaGatewayRest');
  assert.match(rest, /method: 'PATCH'/);
  assert.match(rest, /body: JSON\.stringify\(\{ title \}\)/);
  assert.match(rest, /encodeSessionId\(sessionId\)/);

  const dashboard = functionBody(source, 'renameSessionViaDashboardRest');
  assert.match(dashboard, /renameSessionViaTab\(\{/);
  assert.match(dashboard, /scriptingApi: browserApi\.scripting/);
  assert.match(dashboard, /dashboardApiRequest\(path/);

  const main = functionBody(source, 'renameHermesSessionTitle');
  assert.ok(main.indexOf('renameSessionViaGatewayRpc(sessionId, nextTitle)') > -1);
  assert.ok(
    main.indexOf('renameSessionViaGatewayRpc(sessionId, nextTitle)') < main.indexOf('renameSessionViaGatewayRest(sessionId, nextTitle)'),
    'RPC must be attempted before the Bearer REST path',
  );
  assert.ok(
    main.indexOf('renameSessionViaGatewayRest(sessionId, nextTitle)') < main.indexOf('renameSessionViaDashboardRest(sessionId, nextTitle)'),
    'dashboard REST must be the last resort',
  );
  // A rename that cannot be confirmed throws (no fake local "saved" state).
  assert.match(main, /throw new Error\(message\)/);
  assert.match(main, /console\.warn\('\[Hermes Browser\] Session rename was not confirmed by Hermes:', failures\)/);
  assert.match(source, /function sessionRenameFailureMessage\(failures = \[\]\)/);
  assert.match(source, /Hermes did not confirm the rename/);
});

test('sidepanel rename editor updates optimistically, reconciles on failure, and reports it', () => {
  const source = read('sidepanel.js');
  const submit = functionBody(source, 'submitSessionRename');

  assert.match(submit, /applySessionTitleLocally\(sessionId, nextTitle\)/);
  assert.ok(
    submit.indexOf('applySessionTitleLocally(sessionId, nextTitle)') < submit.indexOf('await renameHermesSessionTitle(sessionId, nextTitle)'),
    'the optimistic render must land before the write is awaited',
  );
  assert.match(submit, /await renameHermesSessionTitle\(sessionId, nextTitle\)/);
  // Failure reverts the optimistic title, surfaces status, and reopens the
  // editor with the attempted name + the error.
  assert.match(submit, /applySessionTitleLocally\(sessionId, previousTitle\)/);
  assert.match(submit, /setStatus\('warn', 'Could not rename session'/);
  assert.match(submit, /openSessionRenameEditor\(\{ id: sessionId, title: previousTitle \}, \{ draft: nextTitle, error: error\?\.message \|\| String\(error\) \}\)/);

  // The local projection never touches storage without a confirmed write path
  // (it only mirrors settings for the active session).
  const local = functionBody(source, 'applySessionTitleLocally');
  assert.match(local, /hermesBrowserSettings: settings/);
});

test('sidepanel auto-naming persists through the shared rename path and cannot clobber a user title', () => {
  const source = read('sidepanel.js');

  // Trigger: title computed at turn start, persisted at turn completion.
  assert.match(source, /const autoTitle = turnOptions\.disableAutoTitle \? '' : autoTitleForCurrentTurn\(userText\);/);
  assert.match(source, /if \(autoTitle\) await maybeAutoNameCurrentSession\(autoTitle\);/);

  const compute = functionBody(source, 'autoTitleForCurrentTurn');
  assert.match(compute, /settings\.autoNameSessions === false/);
  assert.match(compute, /isDefaultBrowserSessionTitle\(currentTitle\)/);

  const persist = functionBody(source, 'maybeAutoNameCurrentSession');
  // Same persistence chain as the manual rename (session.title RPC first).
  assert.match(persist, /await renameHermesSessionTitle\(settings\.sessionId, cleanTitle, \{ quiet: true \}\)/);
  // Revalidated at persist time: only default titles are ever replaced.
  assert.match(persist, /isDefaultBrowserSessionTitle\(currentTitle\)/);
  assert.match(persist, /console\.warn\('\[Hermes Browser\] Auto-name skipped:'/);
});

test('full-tab rename uses the same editor and prefers the session.title RPC', () => {
  const app = read('app.js');
  const css = read('app.css');

  assert.doesNotMatch(app, /promptRenameHermesWebSession/);
  for (const name of ['openWebSessionRenameEditor', 'renderWebSessionRenameEditor', 'submitWebSessionRename', 'renameHermesWebSessionTitle']) {
    const body = functionBody(app, name);
    assert.ok(body.length > 0, `${name} must exist`);
    assert.doesNotMatch(body, /window\.prompt/, `${name} must not open a native prompt`);
  }

  assert.match(app, /form\.className = 'session-row-rename-form';/);
  assert.match(app, /input\.className = 'session-row-rename-input';/);
  assert.match(app, /save\.textContent = translateUiText\('Save'\);/);
  assert.match(app, /cancel\.textContent = translateUiText\('Cancel'\);/);
  assert.match(app, /event\.key === 'Escape'[\s\S]{0,160}closeWebSessionRenameEditor\(\)/);
  assert.match(app, /openWebSessionRenameEditor\(session\)/);

  const rename = functionBody(app, 'renameHermesWebSessionTitle');
  assert.match(rename, /connection\.client\.request\(WS_METHODS\.sessionTitle, \{ session_id: liveId, title: cleanTitle \}\)/);
  assert.match(rename, /method: 'PATCH'/, 'REST stays as the non-live fallback');

  const submit = functionBody(app, 'submitWebSessionRename');
  assert.match(submit, /applyWebSessionTitleLocally\(sessionId, nextTitle\)/);
  assert.match(submit, /applyWebSessionTitleLocally\(sessionId, previousTitle\)/);
  assert.match(submit, /Could not rename session/);

  assert.match(css, /\.session-row-rename-form \{/);
  assert.match(css, /\.session-row-rename-input \{/);
  assert.match(css, /\.session-row-rename-status \{/);
});

test('dashboardSessionUrl builds the profile-scoped session PATCH URL', () => {
  assert.equal(dashboardSessionUrl('https://host.ts.net', 'abc/1', ''), 'https://host.ts.net/api/sessions/abc%2F1');
  assert.equal(
    dashboardSessionUrl('https://host.ts.net/hermes', 's1', 'work'),
    'https://host.ts.net/hermes/api/sessions/s1?profile=work',
  );
  assert.equal(
    dashboardSessionUrl('https://host.ts.net/hermes?x=1#frag', 's1'),
    'https://host.ts.net/hermes/api/sessions/s1',
  );
});

test('renameSessionInPage PATCHes the title with the dashboard session token', async () => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/api/sessions/')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, title: 'Renamed' }) };
      }
      return { ok: true, status: 200, text: async () => '<html>window.__HERMES_SESSION_TOKEN__ = "tok-1"</html>' };
    };
    const result = await renameSessionInPage({
      baseUrl: 'https://host.ts.net',
      sessionId: 's1',
      title: 'Renamed',
      profile: 'work',
    });
    assert.deepEqual(result, { ok: true, title: 'Renamed' });

    const patch = calls.find((call) => call.options.method === 'PATCH');
    assert.equal(patch.url, 'https://host.ts.net/api/sessions/s1?profile=work');
    assert.equal(patch.options.headers['X-Hermes-Session-Token'], 'tok-1');
    assert.equal(patch.options.credentials, 'include');
    assert.deepEqual(JSON.parse(patch.options.body), { title: 'Renamed', profile: 'work' });
  } finally {
    globalThis.fetch = original;
  }
});

test('renameSessionInPage maps failures to structured reasons', async () => {
  const original = globalThis.fetch;
  try {
    const withRoot = (status, payload) => async (url) => {
      if (String(url).includes('/api/sessions/')) {
        return { ok: false, status, json: async () => payload };
      }
      return { ok: true, status: 200, text: async () => 'window.__HERMES_SESSION_TOKEN__ = "tok-1"' };
    };

    globalThis.fetch = withRoot(401, {});
    assert.deepEqual(
      await renameSessionInPage({ baseUrl: 'https://host.ts.net', sessionId: 's1', title: 'X' }),
      { ok: false, reason: 'not_signed_in', status: 401 },
    );

    globalThis.fetch = withRoot(404, { detail: 'Session not found' });
    const notFound = await renameSessionInPage({ baseUrl: 'https://host.ts.net', sessionId: 's1', title: 'X' });
    assert.equal(notFound.reason, 'session_http_404');
    assert.equal(notFound.detail, 'Session not found');

    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>no token</html>' });
    assert.equal(
      (await renameSessionInPage({ baseUrl: 'https://host.ts.net', sessionId: 's1', title: 'X' })).reason,
      'no_dashboard_session_token',
    );

    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const failed = await renameSessionInPage({ baseUrl: 'https://host.ts.net', sessionId: 's1', title: 'X' });
    assert.equal(failed.reason, 'fetch_failed');
    assert.match(failed.detail, /network down/);
  } finally {
    globalThis.fetch = original;
  }
});

test('renameSessionViaTab runs the first-party PATCH inside the trusted tab', async () => {
  let injected = null;
  const result = await renameSessionViaTab({
    tabsApi: {
      get: async (tabId) => ({ id: tabId, url: 'https://host.ts.net/chat', status: 'complete', discarded: false }),
    },
    scriptingApi: {
      executeScript: async (options) => {
        injected = options;
        return [{ result: { ok: true, title: 'In-tab rename' } }];
      },
    },
    baseUrl: 'https://host.ts.net',
    sessionId: 's1',
    title: 'In-tab rename',
    profile: 'work',
    tabId: 7,
  });

  assert.deepEqual(result, { ok: true, title: 'In-tab rename' });
  assert.equal(injected.target.tabId, 7);
  assert.deepEqual(injected.args, [{
    baseUrl: 'https://host.ts.net',
    sessionId: 's1',
    title: 'In-tab rename',
    profile: 'work',
  }]);
});

test('renameSessionViaTab reports no_dashboard_tab instead of guessing a transport', async () => {
  const result = await renameSessionViaTab({
    tabsApi: { query: async () => [] },
    scriptingApi: { executeScript: async () => [{ result: { ok: true } }] },
    baseUrl: 'https://host.ts.net',
    sessionId: 's1',
    title: 'X',
  });
  assert.deepEqual(result, { ok: false, reason: 'no_dashboard_tab', origin: 'https://host.ts.net' });
});

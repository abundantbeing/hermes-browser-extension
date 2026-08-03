import test from 'node:test';
import assert from 'node:assert/strict';

import {
  originOf,
  wsTicketUrl,
  mintTicketInPage,
  findDashboardTab,
  mintWsTicket,
  ticketFailureHelp,
  dashboardProfilesUrl,
  discoverProfilesInPage,
  discoverProfilesViaTab,
  discoverProfilesFromDashboard,
} from '../extension/lib/dashboard-bridge.mjs';

test('originOf and wsTicketUrl normalize the dashboard base', () => {
  assert.equal(originOf('https://kurokami.example.ts.net/some/path?q=1'), 'https://kurokami.example.ts.net');
  assert.equal(originOf('not a url'), '');
  assert.equal(wsTicketUrl('https://host.ts.net/'), 'https://host.ts.net/api/auth/ws-ticket');
  assert.equal(wsTicketUrl('https://host.ts.net/hermes'), 'https://host.ts.net/hermes/api/auth/ws-ticket');
  // Query/hash from a pasted address bar URL must not corrupt the ticket path.
  assert.equal(wsTicketUrl('https://host.ts.net/hermes?x=1#y'), 'https://host.ts.net/hermes/api/auth/ws-ticket');
});

test('mintTicketInPage maps fetch outcomes to structured results', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'T1', ttl_seconds: 30 }) });
    assert.deepEqual(await mintTicketInPage('https://h/api/auth/ws-ticket'), { ok: true, ticket: 'T1', ttlSeconds: 30 });

    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    assert.deepEqual(await mintTicketInPage('https://h/api/auth/ws-ticket'), { ok: false, reason: 'not_signed_in', status: 401 });

    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal((await mintTicketInPage('https://h/api/auth/ws-ticket')).reason, 'ticket_http_500');

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    assert.equal((await mintTicketInPage('https://h/api/auth/ws-ticket')).reason, 'no_ticket_in_response');

    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    const failed = await mintTicketInPage('https://h/api/auth/ws-ticket');
    assert.equal(failed.reason, 'fetch_failed');
    assert.match(failed.detail, /network down/);
  } finally {
    globalThis.fetch = original;
  }
});

test('findDashboardTab picks a loaded same-origin tab and skips discarded ones', async () => {
  const tabsApi = {
    query: async ({ url }) => {
      assert.equal(url, 'https://host.ts.net/*');
      return [
        { id: 1, url: 'https://host.ts.net/login', discarded: true },
        { id: 2, url: 'https://host.ts.net/dashboard', discarded: false },
      ];
    },
  };
  const tab = await findDashboardTab(tabsApi, 'https://host.ts.net');
  assert.equal(tab.id, 2);

  const none = await findDashboardTab({ query: async () => [] }, 'https://host.ts.net');
  assert.equal(none, null);
});

test('mintWsTicket returns no_dashboard_tab when no tab is open', async () => {
  const result = await mintWsTicket({
    tabsApi: { query: async () => [] },
    scriptingApi: { executeScript: async () => [{ result: { ok: true } }] },
    baseUrl: 'https://host.ts.net',
  });
  assert.deepEqual(result, { ok: false, reason: 'no_dashboard_tab', origin: 'https://host.ts.net' });
});

test('mintWsTicket injects the mint into the dashboard tab with the ticket URL', async () => {
  let injected = null;
  const result = await mintWsTicket({
    tabsApi: { query: async () => [{ id: 7, url: 'https://host.ts.net/x', discarded: false }] },
    scriptingApi: {
      executeScript: async (opts) => {
        injected = opts;
        return [{ result: { ok: true, ticket: 'TKT', ttlSeconds: 30 } }];
      },
    },
    baseUrl: 'https://host.ts.net',
    mintFn: () => {},
  });
  assert.deepEqual(result, { ok: true, ticket: 'TKT', ttlSeconds: 30 });
  assert.equal(injected.target.tabId, 7);
  assert.deepEqual(injected.args, ['https://host.ts.net/api/auth/ws-ticket']);
});

test('ticketFailureHelp gives actionable copy per reason', () => {
  assert.match(ticketFailureHelp('no_dashboard_tab', 'https://host.ts.net'), /Open https:\/\/host\.ts\.net.*sign in/);
  assert.match(ticketFailureHelp('not_signed_in'), /not signed in/i);
});

test('dashboardProfilesUrl builds a first-party /api/profiles URL', () => {
  assert.equal(dashboardProfilesUrl('https://host.ts.net/'), 'https://host.ts.net/api/profiles');
  assert.equal(dashboardProfilesUrl('https://host.ts.net/hermes'), 'https://host.ts.net/hermes/api/profiles');
  // Pasted address-bar URL with query/hash must not corrupt the path.
  assert.equal(dashboardProfilesUrl('https://host.ts.net/hermes?x=1#y'), 'https://host.ts.net/hermes/api/profiles');
  assert.equal(dashboardProfilesUrl('https://host.ts.net/', 'sebastian'), 'https://host.ts.net/api/profiles?profile=sebastian');
});

test('discoverProfilesInPage bootstraps the session token and reads the roster', async () => {
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), token: options.headers?.['X-Hermes-Session-Token'] || '' });
    if (String(url).endsWith('/api/profiles')) {
      return { ok: true, status: 200, json: async () => ({ profiles: [{ name: 'default' }, { name: 'sebastian', model: 'gpt-5' }] }) };
    }
    return { ok: true, status: 200, text: async () => '<script>window.__HERMES_SESSION_TOKEN__="tok123";</script>' };
  };
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const result = await discoverProfilesInPage('https://host.ts.net/');
    assert.equal(result.ok, true);
    assert.deepEqual(result.profiles.map((p) => p.name), ['default', 'sebastian']);
    assert.equal(calls[1].token, 'tok123');
    assert.equal(calls[1].url, 'https://host.ts.net/api/profiles');
  } finally {
    globalThis.fetch = original;
  }
});

test('discoverProfilesInPage reports not_signed_in when the dashboard rejects it', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/profiles')) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, text: async () => '<script>window.__HERMES_SESSION_TOKEN__="tok";</script>' };
  };
  try {
    const result = await discoverProfilesInPage('https://host.ts.net/');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_signed_in');
  } finally {
    globalThis.fetch = original;
  }
});

test('discoverProfilesInPage reports missing token when the dashboard boot does not expose one', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>no token here</html>' });
  try {
    const result = await discoverProfilesInPage('https://host.ts.net/');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_dashboard_session_token');
  } finally {
    globalThis.fetch = original;
  }
});

test('discoverProfilesViaTab runs first-party in a signed-in dashboard tab', async () => {
  let injected = null;
  const result = await discoverProfilesViaTab({
    tabsApi: { query: async () => [{ id: 9, url: 'https://host.ts.net/x', discarded: false }] },
    scriptingApi: {
      executeScript: async (opts) => {
        injected = opts;
        return [{ result: { ok: true, profiles: [{ name: 'sebastian' }] } }];
      },
    },
    baseUrl: 'https://host.ts.net',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profiles.map((p) => p.name), ['sebastian']);
  assert.equal(injected.target.tabId, 9);
  assert.deepEqual(injected.args, ['https://host.ts.net', '']);
});

test('discoverProfilesViaTab returns no_dashboard_tab when no tab is open', async () => {
  const result = await discoverProfilesViaTab({
    tabsApi: { query: async () => [] },
    scriptingApi: { executeScript: async () => [{ result: { ok: true } }] },
    baseUrl: 'https://host.ts.net',
  });
  assert.deepEqual(result, { ok: false, reason: 'no_dashboard_tab', origin: 'https://host.ts.net' });
});

test('discoverProfilesFromDashboard extracts the token and reads the roster via fetchFn', async () => {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url: String(url), token: options.headers?.['X-Hermes-Session-Token'] || '' });
    if (String(url).endsWith('/api/profiles')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ profiles: [{ name: 'sebastian', model: 'gpt-5' }] }) };
    }
    return { ok: true, status: 200, text: async () => '<script>window.__HERMES_SESSION_TOKEN__="abc";</script>' };
  };
  const result = await discoverProfilesFromDashboard({ baseUrl: 'https://host.ts.net/', fetchFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profiles.map((p) => p.name), ['sebastian']);
  assert.equal(calls[1].token, 'abc');
  assert.equal(calls[1].url, 'https://host.ts.net/api/profiles');
});

test('discoverProfilesFromDashboard reports a clear error on a bad base url', async () => {
  const result = await discoverProfilesFromDashboard({ baseUrl: '', fetchFn: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-dashboard-url');
  assert.deepEqual(result.profiles, []);
});

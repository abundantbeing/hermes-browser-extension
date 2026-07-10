import test from 'node:test';
import assert from 'node:assert/strict';

import {
  originOf,
  wsTicketUrl,
  dashboardProfilesUrl,
  mintTicketInPage,
  fetchProfilesInPage,
  findDashboardTab,
  mintWsTicket,
  fetchDashboardProfiles,
  ticketFailureHelp,
} from '../extension/lib/dashboard-bridge.mjs';

test('originOf and wsTicketUrl normalize the dashboard base', () => {
  assert.equal(originOf('https://kurokami.example.ts.net/some/path?q=1'), 'https://kurokami.example.ts.net');
  assert.equal(originOf('not a url'), '');
  assert.equal(wsTicketUrl('https://host.ts.net/'), 'https://host.ts.net/api/auth/ws-ticket');
  assert.equal(wsTicketUrl('https://host.ts.net/hermes'), 'https://host.ts.net/hermes/api/auth/ws-ticket');
  assert.equal(dashboardProfilesUrl('https://host.ts.net/hermes'), 'https://host.ts.net/hermes/api/profiles');
  // Query/hash from a pasted address bar URL must not corrupt the ticket path.
  assert.equal(wsTicketUrl('https://host.ts.net/hermes?x=1#y'), 'https://host.ts.net/hermes/api/auth/ws-ticket');
});

test('fetchProfilesInPage returns only extension-safe profile metadata', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        active: 'research',
        profiles: [{
          name: 'research',
          is_active: true,
          model: 'model-1',
          provider: 'provider-1',
          skill_count: 4,
          gateway_running: true,
          path: '/private/profile/path',
          has_env: true,
        }],
      }),
    });
    const result = await fetchProfilesInPage('https://h/api/profiles');
    assert.deepEqual(result, {
      ok: true,
      status: 200,
      active: 'research',
      profiles: [{
        name: 'research',
        active: true,
        model: 'model-1',
        provider: 'provider-1',
        gateway_running: true,
        skill_count: 4,
      }],
    });
    assert.doesNotMatch(JSON.stringify(result), /private|has_env/);

    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    assert.equal((await fetchProfilesInPage('https://h/api/profiles')).reason, 'not_signed_in');

    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    assert.equal((await fetchProfilesInPage('https://h/api/profiles')).reason, 'profiles_http_404');

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) });
    assert.equal((await fetchProfilesInPage('https://h/api/profiles')).reason, 'invalid_profiles_response');
  } finally {
    globalThis.fetch = original;
  }
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

test('fetchDashboardProfiles uses the fixed read-only dashboard profiles route', async () => {
  let injected = null;
  const result = await fetchDashboardProfiles({
    tabsApi: { query: async () => [{ id: 9, url: 'https://host.ts.net/hermes/profiles', discarded: false }] },
    scriptingApi: {
      executeScript: async (opts) => {
        injected = opts;
        return [{ result: { ok: true, profiles: [{ name: 'default' }] } }];
      },
    },
    baseUrl: 'https://host.ts.net/hermes',
    fetchFn: () => {},
  });
  assert.deepEqual(result, { ok: true, profiles: [{ name: 'default' }] });
  assert.equal(injected.target.tabId, 9);
  assert.deepEqual(injected.args, ['https://host.ts.net/hermes/api/profiles']);
});

test('fetchDashboardProfiles reports when no signed-in dashboard tab is available', async () => {
  const result = await fetchDashboardProfiles({
    tabsApi: { query: async () => [] },
    scriptingApi: { executeScript: async () => [{ result: { ok: true } }] },
    baseUrl: 'https://host.ts.net',
  });
  assert.deepEqual(result, { ok: false, reason: 'no_dashboard_tab', origin: 'https://host.ts.net' });
});

test('ticketFailureHelp gives actionable copy per reason', () => {
  assert.match(ticketFailureHelp('no_dashboard_tab', 'https://host.ts.net'), /Open https:\/\/host\.ts\.net.*sign in/);
  assert.match(ticketFailureHelp('not_signed_in'), /not signed in/i);
});

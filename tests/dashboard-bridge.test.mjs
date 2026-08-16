import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dashboardTrustPrompt,
  isTrustedDashboardOrigin,
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
  assert.equal(originOf('http://host.ts.net'), '', 'dashboard attach must stay HTTPS-only');
  assert.equal(originOf('https://user:pass@host.ts.net'), '', 'dashboard URLs must not contain credentials');
  assert.equal(wsTicketUrl('https://host.ts.net/'), 'https://host.ts.net/api/auth/ws-ticket');
  assert.equal(wsTicketUrl('https://host.ts.net/hermes'), 'https://host.ts.net/hermes/api/auth/ws-ticket');
  // Query/hash from a pasted address bar URL must not corrupt the ticket path.
  assert.equal(wsTicketUrl('https://host.ts.net/hermes?x=1#y'), 'https://host.ts.net/hermes/api/auth/ws-ticket');
});

test('dashboard trust is bound to one canonical HTTPS origin', () => {
  assert.equal(isTrustedDashboardOrigin('https://host.ts.net/hermes', 'https://host.ts.net'), true);
  assert.equal(isTrustedDashboardOrigin('https://host.ts.net/other', 'https://host.ts.net/'), true);
  assert.equal(isTrustedDashboardOrigin('https://other.ts.net', 'https://host.ts.net'), false);
  assert.equal(isTrustedDashboardOrigin('http://host.ts.net', 'https://host.ts.net'), false);
  assert.match(dashboardTrustPrompt('https://host.ts.net'), /short-lived, single-use WebSocket ticket/i);
  assert.match(dashboardTrustPrompt('https://host.ts.net'), /Chat-only/i);
});

test('mintTicketInPage maps fetch outcomes to structured results', async () => {
  const original = globalThis.fetch;
  try {
    let requestOptions = null;
    globalThis.fetch = async (_url, options) => {
      requestOptions = options;
      return { ok: true, status: 200, json: async () => ({ ticket: 'T1', ttl_seconds: 30 }) };
    };
    assert.deepEqual(await mintTicketInPage('https://h/api/auth/ws-ticket'), { ok: true, ticket: 'T1', ttlSeconds: 30, principal: null });
    assert.equal(requestOptions.credentials, 'include');
    assert.equal(requestOptions.redirect, 'error');
    assert.equal(requestOptions.cache, 'no-store');

    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    assert.deepEqual(await mintTicketInPage('https://h/api/auth/ws-ticket'), { ok: false, reason: 'not_signed_in', status: 401 });

    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal((await mintTicketInPage('https://h/api/auth/ws-ticket')).reason, 'ticket_http_500');

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    assert.equal((await mintTicketInPage('https://h/api/auth/ws-ticket')).reason, 'no_ticket_in_response');

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'T2', ttl_seconds: 0 }) });
    assert.equal((await mintTicketInPage('https://h/api/auth/ws-ticket')).reason, 'invalid_ticket_ttl');

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'x'.repeat(4097), ttl_seconds: 30 }) });
    assert.equal((await mintTicketInPage('https://h/api/auth/ws-ticket')).reason, 'invalid_ticket_response');

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

test('mintTicketInPage binds the ticket to the verified dashboard principal when /api/auth/me is available', async () => {
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/api/auth/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ user_id: 'user-7', provider: 'nous', org_id: 'org-2' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ticket: 'T1', ttl_seconds: 30 }) };
    };
    assert.deepEqual(await mintTicketInPage('https://h/api/auth/ws-ticket'), {
      ok: true,
      ticket: 'T1',
      ttlSeconds: 30,
      principal: { user_id: 'user-7', provider: 'nous', org_id: 'org-2' },
    });
    assert.deepEqual(calls.map((call) => call.url), [
      'https://h/api/auth/me',
      'https://h/api/auth/ws-ticket',
      'https://h/api/auth/me',
    ]);
    assert.equal(calls[0].options.credentials, 'include');
    assert.equal(calls[0].options.cache, 'no-store');
  } finally {
    globalThis.fetch = original;
  }
});

test('mintTicketInPage discards a ticket when the signed-in account changes during mint', async () => {
  const original = globalThis.fetch;
  let identityReads = 0;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/auth/me')) {
        identityReads += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ user_id: identityReads === 1 ? 'user-a' : 'user-b', provider: 'nous', org_id: 'org-2' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ticket: 'T1', ttl_seconds: 30 }) };
    };
    assert.deepEqual(await mintTicketInPage('https://h/api/auth/ws-ticket'), {
      ok: false,
      reason: 'account_identity_changed',
    });
    assert.match(ticketFailureHelp('account_identity_changed'), /account changed/i);
  } finally {
    globalThis.fetch = original;
  }
});

test('mintTicketInPage keeps ticket transport compatible but leaves consent principal unavailable on older dashboards', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => String(url).endsWith('/api/auth/me')
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ ticket: 'T2', ttl_seconds: 30 }) };
    assert.deepEqual(await mintTicketInPage('https://h/api/auth/ws-ticket'), {
      ok: true,
      ticket: 'T2',
      ttlSeconds: 30,
      principal: null,
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('findDashboardTab requires the active loaded same-origin tab', async () => {
  const tabsApi = {
    query: async (query) => {
      assert.deepEqual(query, { active: true, currentWindow: true });
      return [
        { id: 2, url: 'https://host.ts.net/dashboard', status: 'complete', discarded: false },
      ];
    },
  };
  const tab = await findDashboardTab(tabsApi, 'https://host.ts.net');
  assert.equal(tab.id, 2);
  assert.equal(await findDashboardTab(tabsApi, 'https://host.ts.net', 7), null);
  assert.equal(await findDashboardTab(tabsApi, 'https://host.ts.net', 2), null);

  const none = await findDashboardTab({ query: async () => [] }, 'https://host.ts.net');
  assert.equal(none, null);
  assert.equal(await findDashboardTab({ query: async () => [
    { id: 3, url: 'https://other.example/dashboard', status: 'complete', discarded: false },
  ] }, 'https://host.ts.net'), null);
  assert.equal(await findDashboardTab({ query: async () => [
    { id: 4, url: 'https://host.ts.net/dashboard', status: 'loading', discarded: false },
  ] }, 'https://host.ts.net'), null);
});

test('findDashboardTab reuses an exact remembered same-origin tab without requiring it to stay active', async () => {
  let queried = false;
  const tabsApi = {
    query: async () => {
      queried = true;
      return [{ id: 99, url: 'https://unrelated.example.test', status: 'complete', discarded: false }];
    },
    get: async (tabId) => {
      assert.equal(tabId, 7);
      return { id: 7, url: 'https://host.ts.net/dashboard', status: 'complete', discarded: false };
    },
  };

  const tab = await findDashboardTab(tabsApi, 'https://host.ts.net', 7);
  assert.equal(tab.id, 7);
  assert.equal(queried, false, 'an explicit remembered tab must not be replaced by the newly active page');
});

test('findDashboardTab fails closed when an explicit remembered tab cannot be resolved exactly', async () => {
  let queried = false;
  const tab = await findDashboardTab({
    query: async () => {
      queried = true;
      return [{ id: 7, url: 'https://host.ts.net/dashboard', status: 'complete', discarded: false }];
    },
  }, 'https://host.ts.net', 7);

  assert.equal(tab, null);
  assert.equal(queried, false, 'an explicit lease must never degrade into active-tab trust');
});

test('mintWsTicket returns no_dashboard_tab when no tab is open', async () => {
  const result = await mintWsTicket({
    tabsApi: { query: async () => [] },
    scriptingApi: { executeScript: async () => [{ result: { ok: true } }] },
    baseUrl: 'https://host.ts.net',
  });
  assert.deepEqual(result, { ok: false, reason: 'no_dashboard_tab', origin: 'https://host.ts.net' });
});

test('mintWsTicket refuses a different active tab than the selected dashboard tab', async () => {
  const result = await mintWsTicket({
    tabsApi: {
      query: async () => [
        { id: 7, url: 'https://host.ts.net/dashboard', status: 'complete', discarded: false },
      ],
    },
    scriptingApi: { executeScript: async () => [{ result: { ok: true } }] },
    baseUrl: 'https://host.ts.net',
    tabId: 8,
  });
  assert.deepEqual(result, { ok: false, reason: 'no_dashboard_tab', origin: 'https://host.ts.net' });
});

test('mintWsTicket injects the mint into the dashboard tab with the ticket URL', async () => {
  let injected = null;
  const dashboardTab = { id: 7, url: 'https://host.ts.net/x', status: 'complete', discarded: false };
  const result = await mintWsTicket({
    tabsApi: {
      query: async () => [dashboardTab],
      get: async () => ({ ...dashboardTab }),
    },
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

test('mintWsTicket discards a ticket when the selected dashboard tab navigates', async () => {
  const result = await mintWsTicket({
    tabsApi: {
      query: async () => [{ id: 7, url: 'https://host.ts.net/dashboard', status: 'complete', discarded: false }],
      get: async () => ({ id: 7, url: 'https://host.ts.net/login', status: 'complete', discarded: false }),
    },
    scriptingApi: { executeScript: async () => [{ result: { ok: true, ticket: 'MUST_NOT_ESCAPE', ttlSeconds: 30 } }] },
    baseUrl: 'https://host.ts.net',
  });
  assert.deepEqual(result, { ok: false, reason: 'dashboard_tab_changed', origin: 'https://host.ts.net' });
  assert.equal(JSON.stringify(result).includes('MUST_NOT_ESCAPE'), false);
});

test('mintTicketInPage classifies a 4xx mint rejection by re-probing sign-in state', async () => {
  const original = globalThis.fetch;
  try {
    // Signed-in identity but the ticket endpoint rejects with 400 (stale
    // session rotation on the server): must NOT surface as raw
    // ticket_http_400 — the caller needs the recoverable reason.
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/auth/me')) {
        return { ok: true, status: 200, json: async () => ({ user_id: 'u1', provider: 'nous', org_id: '' }) };
      }
      return { ok: false, status: 400, json: async () => ({ detail: 'stale rotation' }) };
    };
    const rejected = await mintTicketInPage('https://h/api/auth/ws-ticket');
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'ticket_endpoint_rejected');
    assert.equal(rejected.status, 400);
    assert.match(String(rejected.detail || ''), /stale rotation/);

    // Session dies mid-mint (signed-in at start, dead on the re-probe):
    // the 400 downgrades to the sign-in reason so the user gets sign-in
    // guidance instead of an opaque HTTP code.
    let meCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/auth/me')) {
        meCalls += 1;
        if (meCalls === 1) {
          return { ok: true, status: 200, json: async () => ({ user_id: 'u1', provider: 'nous', org_id: '' }) };
        }
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return { ok: false, status: 400, json: async () => ({}) };
    };
    const dead = await mintTicketInPage('https://h/api/auth/ws-ticket');
    assert.equal(dead.reason, 'not_signed_in');
    assert.equal(meCalls, 2);

    // 5xx keeps the raw transport reason — no identity re-probe.
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/auth/me')) {
        return { ok: true, status: 200, json: async () => ({ user_id: 'u1', provider: 'nous', org_id: '' }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    assert.equal((await mintTicketInPage('https://h/api/auth/ws-ticket')).reason, 'ticket_http_500');
  } finally {
    globalThis.fetch = original;
  }
});

test('ticketFailureHelp gives actionable copy per reason', () => {
  assert.match(ticketFailureHelp('no_dashboard_tab', 'https://host.ts.net'), /Open https:\/\/host\.ts\.net.*sign in/);
  assert.match(ticketFailureHelp('not_signed_in'), /not signed in/i);
  assert.match(ticketFailureHelp('dashboard_tab_changed'), /changed while connecting/i);
  assert.match(ticketFailureHelp('ticket_endpoint_rejected'), /reload/i);
  assert.match(ticketFailureHelp('ticket_http_400'), /reload/i);
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

test('discoverProfilesInPage survives chrome.scripting serialization (no module scope)', async () => {
  // chrome.scripting.executeScript serializes the function body and runs it in
  // the page realm: module-scope helpers are invisible there. This probe
  // rebuilds the function the same way and proves it still works, so a future
  // refactor cannot reintroduce a dashboardProfilesUrl module reference.
  const serialized = discoverProfilesInPage.toString();
  assert.doesNotMatch(serialized, /dashboardProfilesUrl/);
  assert.match(serialized, /profilesUrlFor/);
  const runner = new Function(`return (${serialized})`)(); // eslint-disable-line no-new-func -- test-only serialization probe, mirrors chrome.scripting.executeScript; no dynamic user input
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/profiles')) {
      return { ok: true, status: 200, json: async () => ({ profiles: [{ name: 'sebastian' }] }) };
    }
    return { ok: true, status: 200, text: async () => '<script>window.__HERMES_SESSION_TOKEN__="tok";</script>' };
  };
  try {
    const result = await runner('https://host.ts.net/');
    assert.equal(result.ok, true);
    assert.deepEqual(result.profiles.map((p) => p.name), ['sebastian']);
  } finally {
    globalThis.fetch = original;
  }
});

test('discoverProfilesViaTab runs first-party in a signed-in dashboard tab', async () => {
  let injected = null;
  const result = await discoverProfilesViaTab({
    tabsApi: { query: async () => [{ id: 9, url: 'https://host.ts.net/x', discarded: false, status: 'complete', active: true }] },
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

// Ticket broker for the OAuth-gated dashboard.
//
// The dashboard mints a WebSocket ticket only on a cookie-authenticated
// POST /api/auth/ws-ticket. From a chrome-extension:// origin that request is
// cross-site: the dashboard's CORS rejects the extension origin and its
// SameSite=Lax session cookie isn't sent. So instead of calling it directly,
// we run the mint INSIDE a logged-in dashboard tab via chrome.scripting — there
// the fetch is first-party (same-origin cookie rides, no foreign CORS).
//
// The chrome APIs are injected so the broker logic is unit-testable. The in-page
// mint function (mintTicketInPage) must stay self-contained: chrome.scripting
// serializes it and runs it in the page, so it cannot close over module scope.

export function originOf(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

export function isTrustedDashboardOrigin(baseUrl, trustedOrigin) {
  const configuredOrigin = originOf(baseUrl);
  return Boolean(configuredOrigin) && configuredOrigin === originOf(trustedOrigin);
}

export function dashboardTrustPrompt(origin) {
  return `Trust ${origin} for Dashboard Attach?\n\nHermes Browser will use the signed-in session in your active dashboard tab to request a short-lived, single-use WebSocket ticket. Dashboard Attach remains Chat-only and will not send browser page context.`;
}

export function wsTicketUrl(baseUrl) {
  // Build from a parsed URL so a pasted address with a query/hash (e.g.
  // copied from the address bar) does not produce ".../hermes?x=1/api/...".
  try {
    const url = new URL(String(baseUrl || ''));
    url.hash = '';
    url.search = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/auth/ws-ticket`;
    return url.toString();
  } catch {
    return `${String(baseUrl || '').replace(/\/+$/, '')}/api/auth/ws-ticket`;
  }
}

// Runs in the dashboard page. Returns a structured result rather than throwing
// so the caller can branch on `reason` (e.g. prompt the user to sign in).
export async function mintTicketInPage(ticketUrl) {
  try {
    const requestOptions = {
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    };
    let principal = null;
    try {
      const identityUrl = new URL(String(ticketUrl || ''));
      identityUrl.pathname = identityUrl.pathname.replace(/\/api\/auth\/ws-ticket$/, '/api/auth/me');
      const identityResponse = await fetch(identityUrl.toString(), {
        method: 'GET',
        ...requestOptions,
      });
      if (identityResponse.status === 401 || identityResponse.status === 403) {
        return { ok: false, reason: 'not_signed_in', status: identityResponse.status };
      }
      if (identityResponse.ok) {
        const identity = await identityResponse.json().catch(() => null);
        const userId = String(identity?.user_id || '').trim();
        const provider = String(identity?.provider || '').trim();
        if (userId && provider) {
          principal = {
            user_id: userId,
            provider,
            org_id: String(identity?.org_id || '').trim(),
          };
        }
      }
    } catch {
      // Older dashboards may not expose /api/auth/me. Ticket transport remains
      // compatible, but Browser context consent fails closed without identity.
      principal = null;
    }
    const response = await fetch(ticketUrl, {
      method: 'POST',
      ...requestOptions,
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'not_signed_in', status: response.status };
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        // The gate answers 401/403 for a dead session, so a 4xx here means
        // the signed-in tab's session hit a server-side rejection (e.g. a
        // stale rotating refresh token after days of inactivity). Re-probe
        // identity so the caller gets a recoverable reason instead of a raw
        // HTTP code.
        const body = await response.json().catch(() => null);
        let reprobe = null;
        try {
          const reprobeUrl = new URL(String(ticketUrl || ''));
          reprobeUrl.pathname = reprobeUrl.pathname.replace(/\/api\/auth\/ws-ticket$/, '/api/auth/me');
          reprobe = await fetch(reprobeUrl.toString(), { method: 'GET', ...requestOptions });
        } catch {
          reprobe = null;
        }
        if (reprobe && (reprobe.status === 401 || reprobe.status === 403)) {
          return { ok: false, reason: 'not_signed_in', status: reprobe.status };
        }
        return {
          ok: false,
          reason: 'ticket_endpoint_rejected',
          status: response.status,
          detail: String(body?.detail || body?.error || ''),
        };
      }
      return { ok: false, reason: `ticket_http_${response.status}`, status: response.status };
    }
    const data = await response.json().catch(() => null);
    const ticket = String(data?.ticket || '').trim();
    if (!ticket) return { ok: false, reason: 'no_ticket_in_response' };
    if (ticket.length > 4096) return { ok: false, reason: 'invalid_ticket_response' };
    const ttlSeconds = Number(data?.ttl_seconds);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 60) {
      return { ok: false, reason: 'invalid_ticket_ttl' };
    }
    if (principal) {
      try {
        const identityUrl = new URL(String(ticketUrl || ''));
        identityUrl.pathname = identityUrl.pathname.replace(/\/api\/auth\/ws-ticket$/, '/api/auth/me');
        const verificationResponse = await fetch(identityUrl.toString(), {
          method: 'GET',
          ...requestOptions,
        });
        if (!verificationResponse.ok) return { ok: false, reason: 'account_identity_changed' };
        const verifiedIdentity = await verificationResponse.json().catch(() => null);
        const verifiedPrincipal = {
          user_id: String(verifiedIdentity?.user_id || '').trim(),
          provider: String(verifiedIdentity?.provider || '').trim(),
          org_id: String(verifiedIdentity?.org_id || '').trim(),
        };
        if (
          !verifiedPrincipal.user_id
          || !verifiedPrincipal.provider
          || verifiedPrincipal.user_id !== principal.user_id
          || verifiedPrincipal.provider !== principal.provider
          || verifiedPrincipal.org_id !== principal.org_id
        ) return { ok: false, reason: 'account_identity_changed' };
      } catch {
        return { ok: false, reason: 'account_identity_changed' };
      }
    }
    return { ok: true, ticket, ttlSeconds, principal };
  } catch (error) {
    return { ok: false, reason: 'fetch_failed', detail: String(error?.message || error) };
  }
}

// First trust requires the dashboard to be the user's active tab. Once the
// exact tab id and origin are approved, reconnects may reuse that explicit
// lease without forcing the user to keep Cloud selected in every new panel.
export async function findDashboardTab(tabsApi, origin, tabId = null) {
  if (!origin) return null;
  const hasExplicitTab = tabId !== null && tabId !== undefined && Number.isFinite(Number(tabId));
  if (hasExplicitTab) {
    if (typeof tabsApi?.get !== 'function') return null;
    try {
      const remembered = await tabsApi.get(Number(tabId));
      if (remembered
        && remembered.id === Number(tabId)
        && !remembered.discarded
        && remembered.status === 'complete'
        && !remembered.pendingUrl
        && originOf(remembered.url) === origin) {
        return remembered;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof tabsApi?.query !== 'function') return null;
  let tabs = [];
  try {
    tabs = await tabsApi.query({ active: true, currentWindow: true });
  } catch {
    return null;
  }
  const usable = (tabs || []).filter(
    (tab) => tab
      && tab.id != null
      && !tab.discarded
      && tab.status === 'complete'
      && !tab.pendingUrl
      && (!Number.isFinite(tabId) || tab.id === tabId)
      && originOf(tab.url) === origin,
  );
  return usable[0] || null;
}

// Mint a fresh ws-ticket (single-use, ~30s TTL) by executing the mint in a
// logged-in dashboard tab. Returns the mintTicketInPage result shape, plus
// { ok:false, reason:'no_dashboard_tab', origin } when no usable tab exists so
// the caller can tell the user to open + sign in to the dashboard.
export async function mintWsTicket({ tabsApi, scriptingApi, baseUrl, tabId = null, mintFn = mintTicketInPage }) {
  const origin = originOf(baseUrl);
  if (!origin) return { ok: false, reason: 'bad_base_url' };
  if (!scriptingApi?.executeScript) return { ok: false, reason: 'scripting_unavailable' };

  const tab = await findDashboardTab(tabsApi, origin, tabId);
  if (!tab?.id) return { ok: false, reason: 'no_dashboard_tab', origin };

  let injection;
  try {
    [injection] = await scriptingApi.executeScript({
      target: { tabId: tab.id },
      func: mintFn,
      args: [wsTicketUrl(baseUrl)],
    });
  } catch (error) {
    return { ok: false, reason: 'inject_failed', detail: String(error?.message || error) };
  }
  const result = injection?.result || { ok: false, reason: 'no_result' };
  if (!result.ok) return result;

  let currentTab;
  try {
    currentTab = await tabsApi.get(tab.id);
  } catch {
    return { ok: false, reason: 'dashboard_tab_changed', origin };
  }
  if (
    !currentTab
    || currentTab.discarded
    || currentTab.status !== 'complete'
    || currentTab.pendingUrl
    || currentTab.url !== tab.url
    || originOf(currentTab.url) !== origin
  ) {
    return { ok: false, reason: 'dashboard_tab_changed', origin };
  }
  return result;
}

// Human-facing message for a mint failure reason.
export function ticketFailureHelp(reason = '', origin = '') {
  switch (reason) {
    case 'no_dashboard_tab':
      return `Open ${origin || 'your Hermes dashboard'} in the active tab, wait for it to load, sign in, then try connecting again.`;
    case 'not_signed_in':
      return 'Your Hermes dashboard tab is not signed in. Sign in there, then try connecting again.';
    case 'bad_base_url':
      return 'The remote gateway URL is not a valid https URL.';
    case 'scripting_unavailable':
      return 'This extension context cannot mint a dashboard ticket.';
    case 'dashboard_tab_changed':
      return 'The active dashboard tab changed while connecting. Return to the signed-in dashboard tab and try again.';
    case 'account_identity_changed':
      return 'The signed-in dashboard account changed while connecting. Confirm the intended account, then try again.';
    case 'ticket_endpoint_rejected':
      return 'The dashboard rejected the ticket request with a stale session. Hard-reload the dashboard tab (Ctrl+Shift+R), sign in again if asked, then try connecting again.';
    default:
      if (/^ticket_http_4\d\d$/.test(String(reason || ''))) {
        return 'The dashboard rejected the ticket request. Hard-reload the dashboard tab (Ctrl+Shift+R), sign in again if asked, then try connecting again.';
      }
      return `Could not get a dashboard WebSocket ticket (${reason || 'unknown'}).`;
  }
}

// ---------------------------------------------------------------------------
// First-party profile discovery for remote-dashboard mode.
//
// The dashboard's REST surface (including /api/profiles) is CORS-blocked from
// the extension origin, so the request must run INSIDE a signed-in dashboard
// tab via chrome.scripting  same as ws-ticket minting. There the fetch is
// first-party (same-origin cookie rides) and the dashboard session token in
// the page bootstraps the authenticated /api/profiles call.
//
// The in-page function (discoverProfilesInPage) must stay self-contained:
// chrome.scripting serializes it and runs it in the page, so it cannot close
// over module scope.
// ---------------------------------------------------------------------------

export function dashboardProfilesUrl(baseUrl = '', profile = '') {
  try {
    const url = new URL(String(baseUrl || '').trim());
    url.hash = '';
    url.search = '';
    const profileName = String(profile || '').trim();
    if (profileName) url.searchParams.set('profile', profileName);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/profiles`;
    return url.toString();
  } catch {
    const params = new URLSearchParams();
    const profileName = String(profile || '').trim();
    if (profileName) params.set('profile', profileName);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return `${String(baseUrl || '').replace(/\/+$/, '')}/api/profiles${suffix}`;
  }
}

// Runs in the dashboard page. Mirrors discoverModelsFromDashboard's token
// bootstrap but reads the profile roster instead of model options. Returns a
// structured result so the caller can branch on `reason`.
//
// This function is serialized into the dashboard page by chrome.scripting, so
// it MUST stay fully self-contained: no module-scope imports, no closures, no
// helper references. The URL builder below is intentionally local.
export async function discoverProfilesInPage(baseUrl, profile = '') {
  const profilesUrlFor = (base = '', profileName = '') => {
    try {
      const url = new URL(String(base || '').trim());
      url.hash = '';
      url.search = '';
      const name = String(profileName || '').trim();
      if (name) url.searchParams.set('profile', name);
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/profiles`;
      return url.toString();
    } catch {
      const params = new URLSearchParams();
      const name = String(profileName || '').trim();
      if (name) params.set('profile', name);
      const suffix = params.toString() ? `?${params.toString()}` : '';
      return `${String(base || '').replace(/\/+$/, '')}/api/profiles${suffix}`;
    }
  };
  try {
    const rootUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    const rootResponse = await fetch(rootUrl, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'include',
    });
    if (!rootResponse.ok) return { ok: false, reason: `dashboard_root_${rootResponse.status}` };
    const html = await rootResponse.text();
    const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
    const token = match?.[1] || '';
    if (!token) return { ok: false, reason: 'no_dashboard_session_token' };

    const response = await fetch(profilesUrlFor(baseUrl, profile), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Hermes-Session-Token': token,
      },
      credentials: 'include',
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'not_signed_in', status: response.status };
    }
    if (!response.ok) return { ok: false, reason: `profiles_http_${response.status}`, status: response.status };
    const data = await response.json().catch(() => null);
    if (!data || !Array.isArray(data.profiles)) return { ok: false, reason: 'no_profiles_in_response' };
    return { ok: true, profiles: data.profiles };
  } catch (error) {
    return { ok: false, reason: 'fetch_failed', detail: String(error?.message || error) };
  }
}

// Discover profiles by executing the discovery inside a logged-in dashboard
// tab. Returns the discoverProfilesInPage result shape, plus
// { ok:false, reason:'no_dashboard_tab', origin } when no usable tab exists.
export async function discoverProfilesViaTab({ tabsApi, scriptingApi, baseUrl, profile = '', discoverFn = discoverProfilesInPage }) {
  const origin = originOf(baseUrl);
  if (!origin) return { ok: false, reason: 'bad_base_url' };
  if (!scriptingApi?.executeScript) return { ok: false, reason: 'scripting_unavailable' };

  const tab = await findDashboardTab(tabsApi, origin);
  if (!tab?.id) return { ok: false, reason: 'no_dashboard_tab', origin };

  let injection;
  try {
    [injection] = await scriptingApi.executeScript({
      target: { tabId: tab.id },
      func: discoverFn,
      args: [baseUrl, profile],
    });
  } catch (error) {
    return { ok: false, reason: 'inject_failed', detail: String(error?.message || error) };
  }
  return injection?.result || { ok: false, reason: 'no_result' };
}

// fetchFn-based discovery (no scripting) for unit tests and the local-dashboard
// scraping fallback. Mirrors discoverModelsFromDashboard's token bootstrap.
export async function discoverProfilesFromDashboard({ baseUrl = '', fetchFn = globalThis.fetch?.bind(globalThis), profile = '' } = {}) {
  const dashboardUrl = String(baseUrl || '').trim();
  if (!dashboardUrl) return { ok: false, error: 'no-dashboard-url', profiles: [] };
  if (typeof fetchFn !== 'function') return { ok: false, error: 'no-fetch', profiles: [] };
  try {
    const rootResponse = await fetchFn(dashboardUrl, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'include',
    });
    if (!rootResponse.ok) return { ok: false, error: `dashboard-root-${rootResponse.status}`, profiles: [] };
    const html = await rootResponse.text();
    const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/);
    const token = match?.[1] || '';
    if (!token) return { ok: false, error: 'no-dashboard-session-token', profiles: [] };

    const optionsResponse = await fetchFn(dashboardProfilesUrl(dashboardUrl, profile), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Hermes-Session-Token': token,
      },
      credentials: 'include',
    });
    const text = await optionsResponse.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 500) };
    }
    if (!optionsResponse.ok) {
      return {
        ok: false,
        error: payload?.detail || payload?.error?.message || payload?.error || `dashboard-profiles-${optionsResponse.status}`,
        profiles: [],
      };
    }
    if (!payload || !Array.isArray(payload.profiles)) return { ok: false, error: 'no-profiles-in-response', profiles: [] };
    return { ok: true, profiles: payload.profiles, error: '' };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'dashboard-timeout' : (error?.message || 'error'), profiles: [] };
  }
}

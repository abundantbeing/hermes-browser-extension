// First-party bridge for the OAuth-gated dashboard.
//
// The dashboard mints a WebSocket ticket only on a cookie-authenticated
// POST /api/auth/ws-ticket. From a chrome-extension:// origin that request is
// cross-site: the dashboard's CORS rejects the extension origin and its
// SameSite=Lax session cookie isn't sent. So instead of calling it directly,
// we run the mint INSIDE a logged-in dashboard tab via chrome.scripting — there
// the fetch is first-party (same-origin cookie rides, no foreign CORS).
//
// The chrome APIs are injected so the bridge logic is unit-testable. In-page
// functions must stay self-contained: chrome.scripting serializes them and runs
// them in the page, so they cannot close over module scope.

export function originOf(url) {
  try {
    return new URL(String(url || '')).origin;
  } catch {
    return '';
  }
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

export function dashboardProfilesUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ''));
    url.hash = '';
    url.search = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/profiles`;
    return url.toString();
  } catch {
    return `${String(baseUrl || '').replace(/\/+$/, '')}/api/profiles`;
  }
}

// Runs in the dashboard page. Returns a structured result rather than throwing
// so the caller can branch on `reason` (e.g. prompt the user to sign in).
export async function mintTicketInPage(ticketUrl) {
  try {
    const response = await fetch(ticketUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'not_signed_in', status: response.status };
    }
    if (!response.ok) {
      return { ok: false, reason: `ticket_http_${response.status}`, status: response.status };
    }
    const data = await response.json().catch(() => null);
    if (!data || !data.ticket) return { ok: false, reason: 'no_ticket_in_response' };
    return { ok: true, ticket: data.ticket, ttlSeconds: Number(data.ttl_seconds || 0) };
  } catch (error) {
    return { ok: false, reason: 'fetch_failed', detail: String(error?.message || error) };
  }
}

// Runs in the signed-in dashboard page. Only the profile fields used by the
// extension cross back into the extension process; local paths and env state
// returned by the dashboard are deliberately discarded.
export async function fetchProfilesInPage(profilesUrl) {
  try {
    const response = await fetch(profilesUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'not_signed_in', status: response.status };
    }
    if (!response.ok) {
      return { ok: false, reason: `profiles_http_${response.status}`, status: response.status };
    }
    const data = await response.json().catch(() => null);
    const rows = Array.isArray(data?.profiles)
      ? data.profiles
      : Array.isArray(data?.data)
        ? data.data
        : null;
    if (!rows) return { ok: false, reason: 'invalid_profiles_response', status: response.status };
    return {
      ok: true,
      status: response.status,
      active: String(data?.active || data?.active_profile || data?.current || ''),
      profiles: rows
        .filter((profile) => profile && (profile.name || profile.id))
        .map((profile) => ({
          name: String(profile.name || profile.id),
          active: Boolean(profile.active || profile.current || profile.is_active || profile.isActive),
          model: String(profile.model || ''),
          provider: String(profile.provider || ''),
          gateway_running: Boolean(profile.gateway_running || profile.gatewayRunning),
          skill_count: Number(profile.skill_count ?? profile.skillCount ?? 0),
        })),
    };
  } catch (error) {
    return { ok: false, reason: 'fetch_failed', detail: String(error?.message || error) };
  }
}

// Find a loaded, non-discarded tab on the dashboard origin that can run the
// first-party mint. Returns the tab or null.
export async function findDashboardTab(tabsApi, origin) {
  if (!origin || !tabsApi?.query) return null;
  let tabs = [];
  try {
    tabs = await tabsApi.query({ url: `${origin}/*` });
  } catch {
    return null;
  }
  const usable = (tabs || []).filter(
    (tab) => tab && tab.id != null && !tab.discarded && originOf(tab.url) === origin,
  );
  return usable[0] || null;
}

// Mint a fresh ws-ticket (single-use, ~30s TTL) by executing the mint in a
// logged-in dashboard tab. Returns the mintTicketInPage result shape, plus
// { ok:false, reason:'no_dashboard_tab', origin } when no usable tab exists so
// the caller can tell the user to open + sign in to the dashboard.
export async function mintWsTicket({ tabsApi, scriptingApi, baseUrl, mintFn = mintTicketInPage }) {
  const origin = originOf(baseUrl);
  if (!origin) return { ok: false, reason: 'bad_base_url' };
  if (!scriptingApi?.executeScript) return { ok: false, reason: 'scripting_unavailable' };

  const tab = await findDashboardTab(tabsApi, origin);
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
  return injection?.result || { ok: false, reason: 'no_result' };
}

// Read the dashboard's profile list through the same signed-in, first-party tab
// used for ws-ticket minting. This is a fixed GET route, not a generic dashboard
// request proxy.
export async function fetchDashboardProfiles({ tabsApi, scriptingApi, baseUrl, fetchFn = fetchProfilesInPage }) {
  const origin = originOf(baseUrl);
  if (!origin) return { ok: false, reason: 'bad_base_url' };
  if (!scriptingApi?.executeScript) return { ok: false, reason: 'scripting_unavailable' };

  const tab = await findDashboardTab(tabsApi, origin);
  if (!tab?.id) return { ok: false, reason: 'no_dashboard_tab', origin };

  let injection;
  try {
    [injection] = await scriptingApi.executeScript({
      target: { tabId: tab.id },
      func: fetchFn,
      args: [dashboardProfilesUrl(baseUrl)],
    });
  } catch (error) {
    return { ok: false, reason: 'inject_failed', detail: String(error?.message || error) };
  }
  return injection?.result || { ok: false, reason: 'no_result' };
}

// Human-facing message for a mint failure reason.
export function ticketFailureHelp(reason = '', origin = '') {
  switch (reason) {
    case 'no_dashboard_tab':
      return `Open ${origin || 'your Hermes dashboard'} in a tab and sign in, then try connecting again.`;
    case 'not_signed_in':
      return 'Your Hermes dashboard tab is not signed in. Sign in there, then try connecting again.';
    case 'bad_base_url':
      return 'The remote gateway URL is not a valid https URL.';
    case 'scripting_unavailable':
      return 'This extension context cannot mint a dashboard ticket.';
    default:
      return `Could not get a dashboard WebSocket ticket (${reason || 'unknown'}).`;
  }
}

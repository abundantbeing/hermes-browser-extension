// Where the Bot Mode roster on screen came from, and so where its avatars come from.
//
// A roster is read from one of two places: the gateway's own authenticated routes
// (GET /v1/profiles, which also serves GET /v1/profiles/{name}/avatar with the same API
// key, on a local or a remote gateway) or a dashboard socket (profiles.list, and
// profiles.get_asset or the Desktop dashboard's avatar route for the picture). An avatar
// has to follow its roster: a roster the gateway served is not on any dashboard, so asking
// a dashboard (or looking for one) for its pictures only fails, and in Remote API mode
// there is no dashboard to look for.
//
// Pure module: the panel passes what it knows.

export const ROSTER_SOURCES = Object.freeze({
  none: '',
  gateway: 'gateway',
  dashboard: 'dashboard',
});

/**
 * The avatar route for one roster row.
 *
 *   gatewayFirst       read the picture from the gateway (needs the API key);
 *   dashboardFallback  may fall back to a dashboard socket or the Desktop dashboard.
 *
 * A gateway-sourced roster uses the gateway only. Otherwise the long-standing order
 * holds: the gateway first when no dashboard is known (and the connection is not a
 * remote dashboard), then a dashboard.
 */
export function botAvatarRoute({ rosterSource = ROSTER_SOURCES.none, hasLocalDashboard = false, remoteWs = false, hasApiKey = false } = {}) {
  const fromGateway = rosterSource === ROSTER_SOURCES.gateway;
  return {
    gatewayFirst: Boolean(hasApiKey) && (fromGateway || (!hasLocalDashboard && !remoteWs)),
    dashboardFallback: !fromGateway,
  };
}

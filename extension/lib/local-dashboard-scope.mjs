// The local Desktop dashboard (a loopback origin found by discovery) and the
// socket opened to it belong to the local gateway only. Once the connection is
// any remote mode, neither may be read, reused or kept: a remote connection must
// never reach the person's own machine. These are the pure decisions; the panel
// applies them (sidepanel.js: localDashboardUrl, resetLocalDashboardState).

export function isLocalGatewayMode(gatewayMode) {
  return String(gatewayMode || '').trim().toLowerCase() === 'local-api';
}

// The discovered dashboard URL, or '' when the connection is not the local one.
export function localDashboardUrlFor(gatewayMode, discoveredUrl) {
  return isLocalGatewayMode(gatewayMode) ? String(discoveredUrl || '') : '';
}

// What to drop when the connection is (or has become) remote. `profileConnection`
// is the panel's own socket to the local dashboard; `activeConnection` is whatever
// the viewed session currently uses. Nothing is dropped on a local connection.
// `profileConnectionIsAccount` marks a socket opened with a Hermes account sign-in on the REMOTE gateway's own
// origin (lib/hermes-account.mjs, which resolves no loopback origin for a remote connection): it does not belong
// to this machine, so a remote connection keeps it. A socket to a loopback origin never passes this flag.
export function localDashboardResetPlan({
  gatewayMode,
  discoveredUrl = '',
  profileConnection = null,
  activeConnection = null,
  conversationTransport = 'rest',
  profileConnectionIsAccount = false,
} = {}) {
  if (isLocalGatewayMode(gatewayMode)) {
    return {
      reset: false,
      clearUrl: false,
      closeProfileConnection: false,
      clearActiveConnection: false,
      conversationTransport,
      clearRoster: false,
    };
  }
  const hasProfile = Boolean(profileConnection) && profileConnectionIsAccount !== true;
  const activeIsLocal = Boolean(activeConnection) && activeConnection === profileConnection && profileConnectionIsAccount !== true;
  const remoteWs = String(gatewayMode || '').trim().toLowerCase() === 'remote-dashboard';
  return {
    reset: Boolean(discoveredUrl) || hasProfile || activeIsLocal,
    clearUrl: Boolean(discoveredUrl),
    closeProfileConnection: hasProfile,
    clearActiveConnection: activeIsLocal,
    // A remote dashboard keeps the socket transport (its own socket is reached through
    // the remote client); any other remote mode goes back to REST when it was on the
    // local dashboard socket.
    conversationTransport: !remoteWs && conversationTransport === 'dashboard-ws' && activeIsLocal
      ? 'rest'
      : conversationTransport,
    clearRoster: hasProfile || activeIsLocal || Boolean(discoveredUrl),
  };
}

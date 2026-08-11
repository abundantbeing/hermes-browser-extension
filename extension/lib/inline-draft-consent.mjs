import {
  contextConsentIdentity,
  contextScopeWithConsent,
  dashboardPrincipalFromMe,
  fingerprintContextCredential,
} from './context-consent.mjs';
import {
  normalizeConnectionTransport,
  transportUsesDashboardTicket,
} from './connection-modes.mjs';

function inlineDraftSettings(settings = {}) {
  return settings && typeof settings === 'object' ? settings : {};
}

export async function gateInlineDraftRequestContext({
  request = {},
  settings = {},
  ledger = null,
  controller = '',
  dashboardPrincipal,
  cryptoImpl = globalThis.crypto,
} = {}) {
  const source = inlineDraftSettings(settings);
  const gatewayUrl = String(source.gatewayUrl || source.agentApiUrl || '');
  const transport = normalizeConnectionTransport(source.connectionTransport || source.gatewayMode || '');
  const profile = String(source.activeProfile || source.profile || 'default');
  let principal = '';

  if (transportUsesDashboardTicket(transport)) {
    principal = dashboardPrincipal === undefined ? '' : dashboardPrincipalFromMe(dashboardPrincipal);
  } else {
    const credential = String(source['api' + 'Key'] || '');
    const fingerprint = credential
      ? await fingerprintContextCredential(credential, cryptoImpl)
      : '';
    principal = fingerprint ? `api:${fingerprint}` : '';
  }

  const identity = principal
    ? contextConsentIdentity({ gatewayUrl, principal, profile, controller, transport })
    : null;
  const gate = contextScopeWithConsent({ mode: 'follow-active-tab' }, {
    gatewayUrl,
    identity,
    ledger,
  });

  return {
    ...gate,
    principal,
    request: gate.allowed
      ? { ...request }
      : {
          ...request,
          pageContext: '',
          pageUrl: '',
          fieldLabel: '',
        },
  };
}

// The Add connection window: what it asks for, what it checks, and the connection it makes.
// Pure, so every rule here is covered by node tests; the window itself (add-connection-dialog.mjs)
// only draws it.

import { DEFAULT_SETTINGS, normalizeGatewayUrl, withGatewayScheme } from './common.mjs';
import {
  CONNECTION_TRANSPORTS,
  isLoopbackGatewayUrl,
  legacyGatewayModeForConnection,
} from './connection-modes.mjs';
import { connectionHeaderProblems, normalizeConnectionHeaders } from './connection-headers.mjs';

export const CONNECTION_TYPES = Object.freeze(['local', 'remote', 'cloud']);
export const SIGN_IN_METHODS = Object.freeze(['browser', 'token']);

export function newConnectionDraft(overrides = {}) {
  return {
    type: 'local',
    name: '',
    address: '',
    method: 'token',
    apiKey: '',
    trustSelfSigned: false,
    headers: [],
    ...overrides,
  };
}

/** Hermes Cloud signs in through the Cloud tab you are on: no address, no sign-in, no options. */
export function stepsFor(draft) {
  return draft?.type === 'cloud' ? ['where'] : ['where', 'signin', 'options'];
}

function parsedAddress(draft) {
  const raw = String(draft?.address ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(withGatewayScheme(raw, { secure: draft.type === 'cloud' }));
  } catch {
    return null;
  }
}

/** The address as it will be saved: local falls back to this computer's default port. */
export function draftGatewayUrl(draft) {
  if (draft?.type === 'cloud') return '';
  const parsed = parsedAddress(draft);
  if (!parsed) return draft?.type === 'local' ? DEFAULT_SETTINGS.gatewayUrl : '';
  return normalizeGatewayUrl(`${parsed.origin}${parsed.pathname}`);
}

const LOCAL_ONLY = 'not-local';

/**
 * What is wrong on one step, as { field: code }. Nothing wrong gives {}.
 * Fields: address, key, headers (an array of { index, field, problem }).
 */
export function stepProblems(draft, step) {
  const problems = {};
  if (step === 'where' && draft.type !== 'cloud') {
    const raw = String(draft.address ?? '').trim();
    const parsed = parsedAddress(draft);
    if (!raw) {
      if (draft.type === 'remote') problems.address = 'required';
    } else if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      problems.address = 'invalid';
    } else if (draft.type === 'local' && !isLoopbackGatewayUrl(parsed.origin)) {
      problems.address = LOCAL_ONLY;
    } else if (draft.type === 'remote' && draft.method === 'browser' && parsed.protocol !== 'https:') {
      problems.address = 'https-required';
    }
  }
  if (step === 'signin' && draft.type !== 'cloud') {
    if (draft.method === 'token' && !String(draft.apiKey ?? '').trim() && draft.type === 'remote') problems.key = 'required';
  }
  if (step === 'options') {
    const rows = connectionHeaderProblems(draft.headers);
    if (rows.length) problems.headers = rows;
  }
  return problems;
}

export function stepIsValid(draft, step) {
  return Object.keys(stepProblems(draft, step)).length === 0;
}

/** The first step with something wrong, or '' when the whole draft can be added. */
export function firstInvalidStep(draft) {
  return stepsFor(draft).find((step) => !stepIsValid(draft, step)) || '';
}

/** The fields a saved connection keeps, as the Settings form would have saved them. */
export function connectionFromDraft(draft) {
  const type = CONNECTION_TYPES.includes(draft?.type) ? draft.type : 'local';
  const token = type !== 'cloud' && draft.method !== 'browser';
  const apiKey = token ? String(draft.apiKey ?? '').trim() : '';
  const connectionTransport = type === 'local'
    ? CONNECTION_TRANSPORTS.LOCAL_API
    : type === 'cloud'
      ? CONNECTION_TRANSPORTS.CLOUD_TICKET_WS
      : (draft.method === 'browser' ? CONNECTION_TRANSPORTS.REMOTE_DASHBOARD : CONNECTION_TRANSPORTS.REMOTE_API);
  return {
    connectionSchemaVersion: DEFAULT_SETTINGS.connectionSchemaVersion,
    connectionMode: type,
    connectionTransport,
    gatewayMode: legacyGatewayModeForConnection({ connectionMode: type, connectionTransport }),
    gatewayUrl: draftGatewayUrl(draft),
    apiKey,
    tokenSource: apiKey ? 'manual' : '',
    trustedDashboardOrigin: '',
    connectionTrustSelfSigned: draft.trustSelfSigned === true && type !== 'cloud',
    connectionHeaders: type === 'cloud' ? [] : normalizeConnectionHeaders(draft.headers),
  };
}

/** What the sign-in step offers for a type: Hermes Cloud has none. */
export function signInMethodsFor(type) {
  return type === 'cloud' ? [] : [...SIGN_IN_METHODS];
}

/** The window opens the address in a tab so the browser can ask about its certificate. */
export function certificateAddress(draft) {
  const parsed = parsedAddress(draft);
  return parsed && parsed.protocol === 'https:' ? parsed.origin : '';
}

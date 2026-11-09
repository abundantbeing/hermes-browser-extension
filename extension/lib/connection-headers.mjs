// Custom headers for one saved connection: for a gateway behind an authenticating proxy.
// They are sent with every request this extension makes to that gateway's address, the chat
// connection included, and to nothing else.

export const HEADER_RULE_ID = 7746;
export const MAX_CONNECTION_HEADERS = 10;
const NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const MAX_VALUE_LENGTH = 2048;

// Names a browser refuses to let a page set, plus the one the sign-in itself owns.
const BLOCKED_NAMES = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'authorization', 'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host',
  'keep-alive', 'origin', 'permissions-policy', 'proxy-authorization', 'proxy-connection', 'referer', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'via', 'x-hermes-profile',
]);

export function headerNameProblem(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return 'empty';
  if (!NAME_PATTERN.test(clean)) return 'invalid';
  const lower = clean.toLowerCase();
  if (BLOCKED_NAMES.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')) return 'blocked';
  return '';
}

export function headerValueProblem(value) {
  const clean = String(value ?? '');
  if (!clean.trim()) return 'empty';
  if ([...clean].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return 'invalid';
  if (clean.length > MAX_VALUE_LENGTH) return 'long';
  return '';
}

/** The headers that are valid, trimmed, without repeats (the first of a name wins) and capped. */
export function normalizeConnectionHeaders(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const headers = [];
  for (const entry of list) {
    const name = String(entry?.name ?? '').trim();
    const value = String(entry?.value ?? '').trim();
    if (headerNameProblem(name) || headerValueProblem(value)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    headers.push({ name, value });
    if (headers.length >= MAX_CONNECTION_HEADERS) break;
  }
  return headers;
}

/** Per-row problems for a form: [{ index, field: 'name' | 'value', problem }]. */
export function connectionHeaderProblems(list) {
  const problems = [];
  const seen = new Map();
  (Array.isArray(list) ? list : []).forEach((entry, index) => {
    const name = String(entry?.name ?? '').trim();
    const value = String(entry?.value ?? '').trim();
    if (!name && !value) return;
    const nameProblem = headerNameProblem(name);
    if (nameProblem) problems.push({ index, field: 'name', problem: nameProblem });
    else if (seen.has(name.toLowerCase())) problems.push({ index, field: 'name', problem: 'repeated' });
    else seen.set(name.toLowerCase(), index);
    const valueProblem = headerValueProblem(value);
    if (valueProblem) problems.push({ index, field: 'value', problem: valueProblem });
  });
  if ((Array.isArray(list) ? list.filter((entry) => String(entry?.name ?? '').trim() || String(entry?.value ?? '').trim()).length : 0) > MAX_CONNECTION_HEADERS) {
    problems.push({ index: MAX_CONNECTION_HEADERS, field: 'name', problem: 'many' });
  }
  return problems;
}

export function connectionHeadersAsObject(list) {
  return Object.fromEntries(normalizeConnectionHeaders(list).map(({ name, value }) => [name, value]));
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The exact origin: scheme (and its WebSocket twin), host and port. Another service on the same host
// but another port is not this connection and gets nothing.
function originPattern(address) {
  try {
    const parsed = new URL(String(address || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const secure = parsed.protocol === 'https:';
    const port = parsed.port ? `:${parsed.port}` : `(:${secure ? 443 : 80})?`;
    return `^(${secure ? 'https|wss' : 'http|ws'})://${escapeRegex(parsed.hostname)}${parsed.port ? escapeRegex(port) : port}/`;
  } catch {
    return '';
  }
}

const RESOURCE_TYPES = ['xmlhttprequest', 'websocket', 'other', 'image', 'media', 'font', 'stylesheet', 'script', 'ping'];

/**
 * The host of this extension's own pages, which is what a request's initiator is: the extension id in
 * Chrome, but a per-install UUID in Firefox (its runtime id is the add-on id, which matches nothing).
 */
export function extensionInitiatorHost(getURL) {
  try {
    return new URL(String(getURL('/'))).hostname;
  } catch {
    return '';
  }
}

/** The network rule for the active connection: its headers, its address, requests from this extension only. */
export function connectionHeaderRules({ gatewayUrl, headers, extensionHost } = {}) {
  const requestHeaders = normalizeConnectionHeaders(headers).map(({ name, value }) => ({ header: name, operation: 'set', value }));
  const pattern = originPattern(gatewayUrl);
  if (!requestHeaders.length || !pattern || !extensionHost) return [];
  return [{
    id: HEADER_RULE_ID,
    priority: 2,
    action: { type: 'modifyHeaders', requestHeaders },
    condition: { regexFilter: pattern, initiatorDomains: [extensionHost], resourceTypes: RESOURCE_TYPES },
  }];
}

export async function applyConnectionHeaderRules(
  { gatewayUrl, headers, extensionHost } = {},
  dnr = globalThis.chrome?.declarativeNetRequest || globalThis.browser?.declarativeNetRequest,
) {
  if (!dnr?.updateSessionRules) return false;
  await dnr.updateSessionRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules: connectionHeaderRules({ gatewayUrl, headers, extensionHost }),
  });
  return true;
}

/**
 * Header syncs run one after another. Each reads what is stored when it starts, so the last one queued
 * always installs the newest headers, and an older read can never put a removed header back.
 */
export function createHeaderRuleSync({ read, apply, onError = () => {} }) {
  let chain = Promise.resolve();
  return () => {
    chain = chain.then(async () => apply(await read())).catch(onError);
    return chain;
  };
}

export const PROBE_PARAM = 'hermes_probe';
// Session rule ids are shared by every open panel and the worker, and a counter restarts in each
// document, so a test takes a random id from a range nothing else uses and never replaces another's.
const PROBE_RULE_ID_BASE = 1_000_000;
const PROBE_RULE_ID_SPAN = 2 ** 30;

export function newProbeRuleId() {
  const [random] = globalThis.crypto?.getRandomValues?.(new Uint32Array(1)) || [Math.floor(Math.random() * 2 ** 32)];
  return PROBE_RULE_ID_BASE + (random % PROBE_RULE_ID_SPAN);
}

/**
 * A test of a connection at the active connection's own address must send only the draft's headers.
 * The active rule would replace them, so a short-lived rule of higher priority, for that one test's
 * requests only (they carry the marker in their query), sets the draft's headers and removes the active
 * connection's others. Null when the test does not meet the active rule.
 */
export function probeHeaderRule({ gatewayUrl, headers, active, extensionHost, marker, id = PROBE_RULE_ID_BASE } = {}) {
  const pattern = originPattern(gatewayUrl);
  const activeNames = normalizeConnectionHeaders(active?.headers).map(({ name }) => name);
  if (!pattern || !extensionHost || !/^[a-z0-9]{6,}$/.test(String(marker || ''))) return null;
  if (!activeNames.length || originPattern(active?.gatewayUrl) !== pattern) return null;
  const draft = normalizeConnectionHeaders(headers);
  const draftNames = new Set(draft.map(({ name }) => name.toLowerCase()));
  return {
    id,
    priority: 3,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        ...draft.map(({ name, value }) => ({ header: name, operation: 'set', value })),
        ...activeNames.filter((name) => !draftNames.has(name.toLowerCase())).map((name) => ({ header: name, operation: 'remove' })),
      ],
    },
    condition: {
      regexFilter: `${pattern}[^#]*[?&]${PROBE_PARAM}=${marker}(?:&|$)`,
      initiatorDomains: [extensionHost],
      resourceTypes: ['xmlhttprequest'],
    },
  };
}

function probeMarker() {
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(8)) || Array.from({ length: 8 }, () => Math.floor(Math.random() * 256));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Runs `probe` with the isolation rule installed while it runs. `probe` is called with the marker to put
 * in each request's query (empty when no rule was needed) and is always cleaned up after.
 */
export async function withProbeHeaderIsolation(
  { gatewayUrl, headers, active, extensionHost },
  probe,
  dnr = globalThis.chrome?.declarativeNetRequest || globalThis.browser?.declarativeNetRequest,
) {
  const marker = probeMarker();
  let rule = dnr?.updateSessionRules ? probeHeaderRule({ gatewayUrl, headers, active, extensionHost, marker, id: newProbeRuleId() }) : null;
  for (let attempt = 0; rule; attempt += 1) {
    try {
      await dnr.updateSessionRules({ addRules: [rule] });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      rule = { ...rule, id: newProbeRuleId() };
    }
  }
  try {
    return await probe(rule ? marker : '');
  } finally {
    if (rule) await dnr.updateSessionRules({ removeRuleIds: [rule.id] }).catch(() => undefined);
  }
}

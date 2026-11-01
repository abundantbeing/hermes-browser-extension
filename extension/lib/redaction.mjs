/**
 * Shared secret redaction helpers for browser-context surfaces.
 */
import { isSensitiveAssignmentKey, redactSensitiveTextWithCount } from './content-extraction-core.mjs';

const CREDENTIAL_URL_PARAMETER_NAMES = new Set([
  'apikey',
  'xapikey',
  'accesstoken',
  'authtoken',
  'refreshtoken',
  'sessiontoken',
  'idtoken',
  'csrftoken',
  'bearertoken',
  'token',
  'clientsecret',
  'password',
  'passwd',
  'secret',
  'privatekey',
  'awssecretaccesskey',
  'secretaccesskey',
  'awsaccesskeyid',
  'xamzcredential',
  'xamzsignature',
  'xamzsecuritytoken',
  'xgoogcredential',
  'xgoogsignature',
  'googleaccessid',
  'credential',
  'signature',
  'sig',
  'pwd',
  'passphrase',
  'sessionid',
  'sessid',
  'phpsessid',
  'jsessionid',
  'apisecret',
  'accesskey',
  'secretkey',
]);
// OAuth callbacks carry a one-time `code` next to `state`. `code` alone is far
// too common (country, promo and language codes) to treat as a credential, and
// so is `code` beside `state` on a store locator (`?state=CA&code=US`). An
// authorization code is a long opaque string, so the value has to look like one.
const OAUTH_CODE_MIN_LENGTH = 12;
// `ticket` is a CAS/SSO service ticket only when it looks like one; on support
// and event sites it is an ordinary id (`?ticket=1234`).
const SERVICE_TICKET_RE = /^(?:ST|PT|TGT|PGT|LT)-[A-Za-z0-9._-]{6,}$/i;
const OPAQUE_TICKET_MIN_LENGTH = 24;

function decodedUrlLayers(value = '') {
  const layers = [String(value || '')];
  for (let index = 0; index < 3; index += 1) {
    const current = layers[layers.length - 1].replace(/\+/g, ' ');
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      decoded = current.replace(/%([0-9a-fA-F]{2})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
    }
    if (decoded === layers[layers.length - 1]) break;
    layers.push(decoded);
  }
  return layers;
}

function normalizedCredentialParameterName(value = '') {
  const layers = decodedUrlLayers(value);
  return layers[layers.length - 1].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Parameter name (normalized) -> every value seen for it across decoding layers.
function credentialParameters(value = '', into = new Map()) {
  for (const layer of decodedUrlLayers(value)) {
    // The value is read in a lookahead so a nested `a=b?token=c` still yields
    // the inner name on the next iteration.
    const assignment = /(?:^|[?&#;\s])([^=?#&;\s]+)\s*=(?=([^&#;\s]*))/g;
    let match;
    while ((match = assignment.exec(layer)) !== null) {
      const name = normalizedCredentialParameterName(match[1]);
      if (!into.has(name)) into.set(name, []);
      into.get(name).push(match[2]);
    }
  }
  return into;
}

function looksLikeOpaqueTicket(values = []) {
  return values.some((candidate) => SERVICE_TICKET_RE.test(candidate)
    || (candidate.length >= OPAQUE_TICKET_MIN_LENGTH && /[a-z]/i.test(candidate) && /\d/.test(candidate)));
}

const CONTEXT_DELIMITER_RE = /(?:USER_REQUEST|UNTRUSTED_BROWSER_CONTEXT)_(?:START|END)|HERMES_PAGE_COMMENTS/gi;

// Services that put the secret in the URL path rather than the query: a Telegram bot API call carries the
// bot token (`/bot123456789:AA…/getMe`), and a Slack or Discord incoming webhook URL is itself the
// credential. Anyone holding one can post as the bot or into the channel.
const PATH_SECRET_PATTERNS = [
  /\/(?:file\/)?bot\d{8,12}:[A-Za-z0-9_-]{30,}(?:\/|$)/,
  /\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}(?:\/|$)/,
  /\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,}(?:\/|$)/,
];

function hasPathSecret(pathname = '') {
  return decodedUrlLayers(pathname).some((layer) => PATH_SECRET_PATTERNS.some((pattern) => pattern.test(layer)));
}

/**
 * Page-derived text is placed between fixed delimiter lines
 * (USER_REQUEST_START/END, UNTRUSTED_BROWSER_CONTEXT_START/END, the page
 * comment wrapper). Page text that spells one of those markers could close the
 * untrusted block early and forge the section after it, so every marker is
 * rewritten (case-insensitively, wherever it appears) into a form no parser or
 * reader treats as a delimiter. Ordinary text is returned unchanged.
 */
export function neutralizeContextDelimiters(value = '') {
  return String(value ?? '').replace(CONTEXT_DELIMITER_RE, (marker) => marker.replaceAll('_', '-'));
}

export function redactSensitiveText(value = '') {
  return redactSensitiveTextWithCount(value).text;
}

/**
 * Detect credential-bearing URL metadata before a tab URL crosses a prompt,
 * receipt, diagnostic, persistence, or transport boundary.
 */
export function hasCredentialBearingUrl(value = '') {
  let parsed;
  try {
    parsed = value instanceof URL ? value : new URL(String(value || ''));
  } catch {
    return true;
  }

  if (parsed.username || parsed.password) return true;
  if (hasPathSecret(parsed.pathname)) return true;
  const parameters = credentialParameters(parsed.hash, credentialParameters(parsed.search));
  const names = [...parameters.keys()];
  if (names.some((name) => CREDENTIAL_URL_PARAMETER_NAMES.has(name) || isSensitiveAssignmentKey(name))) return true;
  if (parameters.has('state') && (parameters.get('code') || []).some((code) => code.length >= OAUTH_CODE_MIN_LENGTH)) return true;
  if (looksLikeOpaqueTicket(parameters.get('ticket') || [])) return true;
  // A recognisable secret shape (for example `?key=AIza...`) is credential
  // bearing whatever the parameter is called.
  return [parsed.search, parsed.hash].some((part) => (
    decodedUrlLayers(part).some((layer) => redactSensitiveTextWithCount(layer).count > 0)
  ));
}

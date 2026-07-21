/**
 * Shared secret redaction helpers for browser-context surfaces.
 */
import { redactSensitiveTextWithCount } from './content-extraction-core.mjs';

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
]);

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

function credentialParameterNames(value = '') {
  const names = new Set();
  for (const layer of decodedUrlLayers(value)) {
    const assignment = /(?:^|[?&#;\s])([^=?#&;\s]+)\s*=/g;
    let match;
    while ((match = assignment.exec(layer)) !== null) {
      names.add(normalizedCredentialParameterName(match[1]));
    }
  }
  return names;
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
  const names = new Set([
    ...credentialParameterNames(parsed.search),
    ...credentialParameterNames(parsed.hash),
  ]);
  return [...names].some((name) => CREDENTIAL_URL_PARAMETER_NAMES.has(name));
}

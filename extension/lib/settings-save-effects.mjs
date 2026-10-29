// What a Settings Save has to do to the conversation on screen.
//
// Save used to re-run the panel-open session initialisation every time, and under the default
// startup mode (a fresh session on open) that replaced the session being viewed, running or not,
// with a new draft, even when only an appearance or inline-assist setting had changed. The
// session only has to be re-established when the connection it was opened over has changed.

// The fields that decide which gateway, under which credential and profile, a session belongs to.
const IDENTITY_FIELDS = ['connectionMode', 'connectionTransport', 'apiKey', 'activeProfile'];

export function connectionIdentityChanged(previous = {}, next = {}, normalizeUrl = (value) => String(value ?? '').trim()) {
  const before = previous && typeof previous === 'object' ? previous : {};
  const after = next && typeof next === 'object' ? next : {};
  if (normalizeUrl(before.gatewayUrl) !== normalizeUrl(after.gatewayUrl)) return true;
  return IDENTITY_FIELDS.some((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
}

/**
 * The session id Save persists. The form's Session ID field is a copy taken when the form was
 * synced; the viewed session can move on while Settings is open (a legacy compression adopts a
 * successor, a roster switch, a new draft). An untouched field must not write that stale copy
 * back over the session on screen, because busy state, Stop, roster matching and context
 * numbers all key on settings.sessionId. Only a value the user typed replaces it.
 */
export function sessionIdForSave({ typed = '', synced, viewed = '', fallback = '' } = {}) {
  const value = String(typed ?? '').trim();
  const untouched = typeof synced === 'string' && value === synced.trim();
  if (untouched) return String(viewed ?? '').trim() || fallback;
  return value || fallback;
}

// The gateway a URL names, for "is this the same gateway": scheme, host and port, with every
// loopback spelling (localhost, 127.0.0.1, [::1]) as one host. '' for a value that is no URL.
function gatewayKey(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.protocol}//${loopback ? 'loopback' : url.hostname.toLowerCase()}:${port}`;
  } catch {
    return '';
  }
}

/**
 * What a move to another gateway must not carry over, as a settings patch ({} for the same one).
 * A bot profile names a profile on the old gateway: the new one may not have it, and every request
 * would go to /p/<that bot>/ there. A pairing token was minted by the old gateway for this browser:
 * it is no credential for another, so it is not sent there. A key the person typed stays, since it
 * is in the field they saved.
 */
export function gatewayMoveResets(previous = {}, next = {}) {
  const before = gatewayKey(previous?.gatewayUrl);
  const after = gatewayKey(next?.gatewayUrl);
  if (!before || !after || before === after) return {};
  const pairedToken = next?.tokenSource === 'pairing' && String(next?.apiKey ?? '') === String(previous?.apiKey ?? '');
  return {
    activeProfile: '',
    botModeSelectedProfile: '',
    botModeReturnProfile: '',
    ...(pairedToken ? { apiKey: '', tokenSource: '' } : {}),
  };
}

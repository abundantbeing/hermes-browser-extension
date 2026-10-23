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

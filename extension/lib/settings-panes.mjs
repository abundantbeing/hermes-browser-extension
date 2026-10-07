// Settings category routing. Presentation only: no persisted keys live here.
// SETTINGS_PANES is the single allowlist for deep links, dirty markers and
// future search. Field ownership comes from the DOM (data-settings-pane), so a
// control can never belong to two categories.

export const SETTINGS_PANES = Object.freeze([
  'appearance',
  'connections',
  'agents',
  'models',
  'sessions',
  'permissions',
  'assist',
  'voice',
  'about',
]);

const PANE_SET = new Set(SETTINGS_PANES);

export function normalizeSettingsPane(value) {
  const pane = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PANE_SET.has(pane) ? pane : '';
}

// Accepts the `{ pane, field }` argument of openSettingsDialog. DOM events
// (the function doubles as a click listener) and unknown shapes resolve to the
// category home, never to an arbitrary selector.
export function resolveSettingsTarget(arg) {
  if (!arg || typeof arg !== 'object' || typeof arg.preventDefault === 'function') {
    return { pane: '', field: '' };
  }
  const pane = normalizeSettingsPane(arg.pane);
  const field = typeof arg.field === 'string' && /^[A-Za-z][\w-]{0,79}$/.test(arg.field) ? arg.field : '';
  return { pane, field };
}

// Snapshot/compare helpers: `entries` is [[paneId, controlKey, value], ...].
export function snapshotControls(entries) {
  const snapshot = new Map();
  for (const [pane, key, value] of entries) snapshot.set(`${pane}\u0000${key}`, String(value));
  return snapshot;
}

export function changedPanes(baseline, entries) {
  const changed = new Set();
  for (const [pane, key, value] of entries) {
    const id = `${pane}\u0000${key}`;
    if (!baseline.has(id) || baseline.get(id) !== String(value)) changed.add(pane);
  }
  return changed;
}

import { getBrowserApi } from './browser-api.mjs';
import {
  appearancePreferencesForSurface,
  applyAppearancePreferences,
} from './appearance-preferences.mjs';

const SETTINGS_KEY = 'hermesBrowserSettings';

export async function applyStoredPanelAppearance(root = globalThis.document?.documentElement, browserApi = getBrowserApi()) {
  if (!root?.style) return null;
  const stored = await browserApi?.storage?.local?.get?.(SETTINGS_KEY).catch(() => ({}));
  const settings = stored?.[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === 'object' ? stored[SETTINGS_KEY] : {};
  return applyAppearancePreferences(root, appearancePreferencesForSurface(settings, 'panel'));
}

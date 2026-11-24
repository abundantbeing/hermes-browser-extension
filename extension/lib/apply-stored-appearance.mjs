import { getBrowserApi } from './browser-api.mjs';
import {
  appearancePreferencesForSurface,
  applyAppearancePreferences,
} from './appearance-preferences.mjs';
import { normalizeAppearanceTheme, normalizeColorMode, resolveColorMode } from './appearance-themes.mjs';
import { customThemeSelection, customThemePaletteForMode, customThemeEffectiveMode, themeCssVariables } from './custom-themes.mjs';
import { readCustomThemeStore } from './custom-theme-store.mjs';

const SETTINGS_KEY = 'hermesBrowserSettings';

export async function applyStoredPanelAppearance(root = globalThis.document?.documentElement, browserApi = getBrowserApi()) {
  if (!root?.style) return null;
  const stored = await browserApi?.storage?.local?.get?.(SETTINGS_KEY).catch(() => ({}));
  const settings = stored?.[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === 'object' ? stored[SETTINGS_KEY] : {};
  return applyAppearancePreferences(root, appearancePreferencesForSurface(settings, 'panel'));
}

// The panel's theme and colour mode on a standalone extension page (voice dictation, background approval).
export async function applyPanelTheme(root, settings = {}, { storageArea, prefersDark = true } = {}) {
  const store = await readCustomThemeStore(storageArea);
  const selection = customThemeSelection(settings.appearanceTheme, store.themes);
  const colorMode = normalizeColorMode(settings.colorMode);
  const mode = resolveColorMode(colorMode, prefersDark);
  if (selection.kind === 'custom') {
    const variables = themeCssVariables(customThemePaletteForMode(selection.document, mode));
    for (const [property, value] of Object.entries(variables)) root.style.setProperty(property, value);
  }
  root.dataset.hermesTheme = selection.kind === 'custom' ? selection.id : normalizeAppearanceTheme(settings.appearanceTheme);
  root.dataset.hermesColorMode = colorMode;
  root.dataset.hermesMode = mode;
  const effectiveMode = selection.kind === 'custom' ? customThemeEffectiveMode(selection.document, mode) : mode;
  root.dataset.hermesEffectiveMode = effectiveMode;
  root.style.colorScheme = effectiveMode;
}

export async function applyStoredPanelTheme(root = globalThis.document?.documentElement, browserApi = getBrowserApi(), prefersDark = true) {
  if (!root?.style) return;
  const stored = await browserApi?.storage?.local?.get?.(SETTINGS_KEY).catch(() => ({}));
  const settings = stored?.[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === 'object' ? stored[SETTINGS_KEY] : {};
  await applyPanelTheme(root, settings, { storageArea: browserApi?.storage?.local, prefersDark });
}

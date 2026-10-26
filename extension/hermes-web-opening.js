// "Opening Hermes Web": the branded page shown while the Webapp's launch tab loads in the background.
// The logic lives in lib/hermes-web-opening-page.mjs; this file wires it to the page and applies the panel's theme.
import { initI18n } from './lib/i18n.mjs';
import { applyStoredPanelAppearance } from './lib/apply-stored-appearance.mjs';
import { getBrowserApi } from './lib/browser-api.mjs';
import { normalizeAppearanceTheme, normalizeColorMode, resolveColorMode } from './lib/appearance-themes.mjs';
import { customThemeSelection, customThemePaletteForMode, customThemeEffectiveMode, themeCssVariables } from './lib/custom-themes.mjs';
import { readCustomThemeStore } from './lib/custom-theme-store.mjs';
import { startOpeningPage } from './lib/hermes-web-opening-page.mjs';

const browserApi = getBrowserApi();
const root = document.documentElement;

async function applyTheme() {
  let settings = {};
  try {
    settings = (await browserApi?.storage?.local?.get?.('hermesBrowserSettings'))?.hermesBrowserSettings || {};
  } catch {
    settings = {};
  }
  const store = await readCustomThemeStore(browserApi?.storage?.local);
  const selection = customThemeSelection(settings.appearanceTheme, store.themes);
  const colorMode = normalizeColorMode(settings.colorMode);
  const mode = resolveColorMode(colorMode, window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (selection.kind === 'custom') {
    for (const [property, value] of Object.entries(themeCssVariables(customThemePaletteForMode(selection.document, mode)))) {
      root.style.setProperty(property, value);
    }
  }
  root.dataset.hermesTheme = selection.kind === 'custom' ? selection.id : normalizeAppearanceTheme(settings.appearanceTheme);
  root.dataset.hermesColorMode = colorMode;
  root.dataset.hermesMode = mode;
  const effectiveMode = selection.kind === 'custom' ? customThemeEffectiveMode(selection.document, mode) : mode;
  root.dataset.hermesEffectiveMode = effectiveMode;
  root.style.colorScheme = effectiveMode;
}

await initI18n();
try {
  await applyStoredPanelAppearance(root);
  await applyTheme();
} catch {
  /* the page still reads on the default theme */
}

const main = document.getElementById('openingMain');
const slowBlock = document.getElementById('openingSlow');
const detail = document.getElementById('openingDetail');
const showButton = document.getElementById('openingShowButton');

const page = await startOpeningPage({
  sendMessage: (message) => browserApi.runtime.sendMessage(message),
  onSlow: () => {
    main?.setAttribute('aria-busy', 'false');
    main?.classList.add('is-slow');
    if (slowBlock) slowBlock.hidden = false;
    if (detail) detail.hidden = true;
    showButton?.focus({ preventScroll: true });
  },
});
showButton?.addEventListener('click', () => {
  showButton.disabled = true;
  page.show().finally(() => { showButton.disabled = false; });
});
window.addEventListener('pagehide', () => page.stop());

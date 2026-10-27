// "Opening Hermes Web": the branded page shown while the Webapp's launch tab loads in the background.
// The logic lives in lib/hermes-web-opening-page.mjs; this file wires it to the page. The page keeps the portal's own
// colours (it is the pairing approval page's design), so it applies no panel theme.
import { initI18n, t } from './lib/i18n.mjs';
import { getBrowserApi } from './lib/browser-api.mjs';
import { startOpeningPage } from './lib/hermes-web-opening-page.mjs';

const browserApi = getBrowserApi();

await initI18n();

const frame = document.querySelector('.opening-frame');
const main = document.getElementById('openingMain');
const slowBlock = document.getElementById('openingSlow');
const detail = document.getElementById('openingDetail');
const showButton = document.getElementById('openingShowButton');
const stateText = document.getElementById('openingState');
const addressRow = document.getElementById('openingAddressRow');
const address = document.getElementById('openingAddress');
const host = document.getElementById('openingHost');

const page = await startOpeningPage({
  sendMessage: (message) => browserApi.runtime.sendMessage(message),
  onSlow: () => {
    main?.setAttribute('aria-busy', 'false');
    frame?.classList.add('is-slow');
    if (stateText) stateText.textContent = t('webapp.opening_state_slow');
    if (slowBlock) slowBlock.hidden = false;
    if (detail) detail.hidden = true;
    showButton?.focus({ preventScroll: true });
  },
});

// The rail names the Webapp being opened (an address only, never the launch URL).
try {
  const origin = page.origin ? new URL(page.origin) : null;
  if (origin && address && addressRow) {
    address.textContent = origin.host;
    addressRow.hidden = false;
  }
  if (origin && host) host.textContent = origin.hostname;
} catch {
  /* the rail keeps its defaults */
}

showButton?.addEventListener('click', () => {
  showButton.disabled = true;
  page.show().finally(() => { showButton.disabled = false; });
});
window.addEventListener('pagehide', () => page.stop());

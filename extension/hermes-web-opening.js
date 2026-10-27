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

// The rail names the Webapp being opened (an address only, never the launch URL).
function nameWebapp(value) {
  try {
    const origin = value ? new URL(value) : null;
    if (!origin || !['http:', 'https:'].includes(origin.protocol)) return;
    if (address && addressRow) {
      address.textContent = origin.host;
      addressRow.hidden = false;
    }
    if (host) host.textContent = origin.hostname;
  } catch {
    /* the rail keeps its defaults */
  }
}

// Framed over the gateway's hand-off page (hermes-web-launch.js), the page only shows: that tab signs itself in and
// moves on to the Webapp, and the gateway's own page reports a problem. It sends the background worker nothing.
if (window.top !== window.self) {
  nameWebapp(new URLSearchParams(location.search).get('origin'));
} else {
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
  nameWebapp(page.origin);
  showButton?.addEventListener('click', () => {
    showButton.disabled = true;
    page.show().finally(() => { showButton.disabled = false; });
  });
  window.addEventListener('pagehide', () => page.stop());
}

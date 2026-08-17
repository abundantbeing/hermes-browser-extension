const CONTROLLER_ADAPTER_IDS = Object.freeze({
  CHROMIUM_CDP: 'chromium-cdp',
  FIREFOX_WEBEXTENSION: 'firefox-webextension',
  UNSUPPORTED: 'unsupported',
});

const CHROMIUM_ACTIONS = Object.freeze([
  'browser_back',
  'browser_click',
  'browser_drag',
  'browser_fill',
  'browser_hover',
  'browser_navigate',
  'browser_press',
  'browser_screenshot',
  'browser_scroll',
  'browser_scroll_to',
  'browser_select',
  'browser_snapshot',
  'browser_tab_activate',
  'browser_tab_close',
  'browser_tab_create',
  'browser_tab_group',
  'browser_tab_ungroup',
  'browser_tabs',
  'browser_type',
]);

const FIREFOX_ACTIONS = Object.freeze([
  'browser_back',
  'browser_navigate',
  'browser_screenshot',
  'browser_scroll',
  'browser_snapshot',
  'browser_tab_activate',
  'browser_tab_close',
  'browser_tab_create',
  'browser_tabs',
]);

const FIREFOX_GAPS = Object.freeze([
  Object.freeze({ action: 'browser_click', reason: 'trusted-input-unavailable' }),
  Object.freeze({ action: 'browser_drag', reason: 'trusted-input-unavailable' }),
  Object.freeze({ action: 'browser_fill', reason: 'trusted-input-unavailable' }),
  Object.freeze({ action: 'browser_hover', reason: 'trusted-input-unavailable' }),
  Object.freeze({ action: 'browser_press', reason: 'trusted-input-unavailable' }),
  Object.freeze({ action: 'browser_scroll_to', reason: 'trusted-input-unavailable' }),
  Object.freeze({ action: 'browser_select', reason: 'trusted-input-unavailable' }),
  Object.freeze({ action: 'browser_type', reason: 'trusted-input-unavailable' }),
]);

function frozenContract({
  id,
  enabled = false,
  actions = [],
  availableApis = [],
  reason = '',
  inputMode = 'unavailable',
  snapshotMode = 'unavailable',
  gaps = [],
}) {
  return Object.freeze({
    id,
    enabled,
    actions: Object.freeze([...actions]),
    availableApis: Object.freeze([...availableApis]),
    reason,
    inputMode,
    snapshotMode,
    gaps: Object.freeze(gaps.map((gap) => Object.freeze({ ...gap }))),
  });
}

function controllerAdapterContractFor({
  product = {},
  capabilities = {},
  controlEnabled = false,
} = {}) {
  const engine = String(product.engine || '').trim();
  let id = CONTROLLER_ADAPTER_IDS.UNSUPPORTED;
  if (engine === 'chromium') id = CONTROLLER_ADAPTER_IDS.CHROMIUM_CDP;
  if (engine === 'gecko') id = CONTROLLER_ADAPTER_IDS.FIREFOX_WEBEXTENSION;

  const availableApis = Object.entries(capabilities.apis || {})
    .filter(([, available]) => available === true)
    .map(([name]) => name)
    .sort();

  if (id === CONTROLLER_ADAPTER_IDS.UNSUPPORTED) {
    return frozenContract({
      id,
      availableApis,
      reason: 'No supported browser controller adapter is available.',
    });
  }
  if (!controlEnabled) {
    return frozenContract({
      id,
      availableApis,
      reason: 'Browser control is disabled because real actions are not enabled until explicitly opted in.',
    });
  }

  const apis = capabilities.apis || {};
  if (id === CONTROLLER_ADAPTER_IDS.CHROMIUM_CDP) {
    if (apis.debugger !== true) {
      return frozenContract({
        id,
        availableApis,
        reason: 'The Chromium debugger API is required for trusted real-tab control.',
      });
    }
    if (apis.tabs !== true) {
      return frozenContract({ id, availableApis, reason: 'The tabs API is required for real-tab control.' });
    }
    return frozenContract({
      id,
      enabled: true,
      actions: CHROMIUM_ACTIONS,
      availableApis,
      inputMode: 'trusted-cdp',
      snapshotMode: 'accessibility-cdp',
    });
  }

  if (apis.scripting !== true) {
    return frozenContract({
      id,
      availableApis,
      reason: 'The scripting API is required for Firefox safe control.',
    });
  }
  if (apis.tabs !== true) {
    return frozenContract({ id, availableApis, reason: 'The tabs API is required for Firefox safe control.' });
  }
  return frozenContract({
    id,
    enabled: true,
    actions: FIREFOX_ACTIONS,
    availableApis,
    inputMode: 'unavailable',
    snapshotMode: 'content-script',
    gaps: FIREFOX_GAPS,
  });
}

export {
  CHROMIUM_ACTIONS,
  CONTROLLER_ADAPTER_IDS,
  FIREFOX_ACTIONS,
  FIREFOX_GAPS,
  controllerAdapterContractFor,
};

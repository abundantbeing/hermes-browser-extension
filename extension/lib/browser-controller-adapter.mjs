const CONTROLLER_ADAPTER_IDS = Object.freeze({
  CHROMIUM_CDP: 'chromium-cdp',
  FIREFOX_WEBEXTENSION: 'firefox-webextension',
  UNSUPPORTED: 'unsupported',
});

function controllerAdapterContractFor({ product = {}, capabilities = {} } = {}) {
  const engine = String(product.engine || '').trim();
  let id = CONTROLLER_ADAPTER_IDS.UNSUPPORTED;
  if (engine === 'chromium') id = CONTROLLER_ADAPTER_IDS.CHROMIUM_CDP;
  if (engine === 'gecko') id = CONTROLLER_ADAPTER_IDS.FIREFOX_WEBEXTENSION;

  const availableApis = Object.entries(capabilities.apis || {})
    .filter(([, available]) => available === true)
    .map(([name]) => name)
    .sort();

  return Object.freeze({
    id,
    enabled: false,
    actions: Object.freeze([]),
    availableApis: Object.freeze(availableApis),
    reason: id === CONTROLLER_ADAPTER_IDS.UNSUPPORTED
      ? 'No supported browser controller adapter is available.'
      : 'Browser control is disabled in Phase 3 while the adapter contract is established.',
  });
}

export {
  CONTROLLER_ADAPTER_IDS,
  controllerAdapterContractFor,
};

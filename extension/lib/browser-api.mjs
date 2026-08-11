function resolveBrowserApi({
  browserApi = globalThis.browser,
  chromeApi = globalThis.chrome,
} = {}) {
  if (browserApi) {
    return {
      api: browserApi,
      namespace: 'browser',
      available: true,
    };
  }
  if (chromeApi) {
    return {
      api: chromeApi,
      namespace: 'chrome',
      available: true,
    };
  }
  return {
    api: null,
    namespace: 'unavailable',
    available: false,
  };
}

function getBrowserApi(options = {}) {
  return resolveBrowserApi(options).api;
}

export {
  getBrowserApi,
  resolveBrowserApi,
};

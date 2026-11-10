(() => {
  if (globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__) return;
  globalThis.hermesBrowserApi = globalThis.browser || globalThis.chrome || null;
})();

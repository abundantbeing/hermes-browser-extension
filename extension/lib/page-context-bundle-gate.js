(() => {
  'use strict';

  const deferredRuns = [];

  function notifyPolicyDecision(inject) {
    if (!inject) return;
    const pending = deferredRuns.splice(0);
    for (const run of pending) {
      try {
        run();
      } catch (_error) {
        /* a deferred bundle step failed; later installs may retry */
      }
    }
  }

  globalThis.__hermesPageScriptPolicyDecided = notifyPolicyDecision;

  function pageScriptPolicyPromise() {
    const gate = globalThis.__HERMES_PAGE_SCRIPT_POLICY__;
    if (gate?.promise) return gate.promise;
    if (globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__) return Promise.resolve(false);
    return Promise.resolve(true);
  }

  globalThis.hermesPageScriptPolicyPromise = pageScriptPolicyPromise;
  globalThis.hermesAwaitPageScriptPolicy = function hermesAwaitPageScriptPolicy(continueFn) {
    pageScriptPolicyPromise().then((inject) => {
      if (inject) continueFn();
      else if (typeof continueFn === 'function') deferredRuns.push(continueFn);
    });
  };

  globalThis.hermesRefreshPageScriptPolicy = function hermesRefreshPageScriptPolicy() {
    const browserApi = globalThis.browser || globalThis.chrome;
    if (!browserApi?.runtime?.sendMessage) return Promise.resolve(false);
    const message = { type: 'HERMES_PAGE_SCRIPT_POLICY', url: location.href };
    const apply = (response) => {
      const inject = response && typeof response.inject === 'boolean' ? response.inject : false;
      globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !inject;
      const gate = globalThis.__HERMES_PAGE_SCRIPT_POLICY__;
      if (gate?._resolvePolicy) gate._resolvePolicy(inject);
      else globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !inject;
      if (inject) notifyPolicyDecision(true);
      return inject;
    };
    return new Promise((resolve) => {
      try {
        if (typeof globalThis.browser?.runtime?.sendMessage === 'function') {
          Promise.resolve(globalThis.browser.runtime.sendMessage(message))
            .then((response) => resolve(apply(response)))
            .catch(() => resolve(false));
        } else {
          browserApi.runtime.sendMessage(message, (response) => {
            if (browserApi.runtime.lastError) resolve(false);
            else resolve(apply(response));
          });
        }
      } catch {
        resolve(false);
      }
    });
  };
})();

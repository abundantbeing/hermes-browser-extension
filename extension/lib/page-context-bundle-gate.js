(() => {
  'use strict';

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
    });
  };
})();

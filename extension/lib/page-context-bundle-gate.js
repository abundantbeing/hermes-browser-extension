(() => {
  'use strict';

  const DEFERRED_RUNS_KEY = '__HERMES_PAGE_SCRIPT_DEFERRED_RUNS__';

  function deferredRuns() {
    if (!globalThis[DEFERRED_RUNS_KEY]) globalThis[DEFERRED_RUNS_KEY] = [];
    return globalThis[DEFERRED_RUNS_KEY];
  }

  function notifyPolicyDecision(inject) {
    if (!inject) return;
    const pending = deferredRuns().splice(0);
    for (const run of pending) {
      try {
        run();
      } catch (_error) {
        /* a deferred bundle step failed; later installs may retry */
      }
    }
  }

  globalThis.__hermesPageScriptPolicyDecided = notifyPolicyDecision;

  function pageScriptPolicyLocationToken() {
    let href = '';
    let origin = '';
    try {
      href = String(location.href || '');
      origin = String(location.origin || '');
    } catch {
      return '';
    }
    if (!href) return '';
    return `${origin}\u0000${href}`;
  }

  function ensurePageScriptPolicyRecord() {
    if (!globalThis.__HERMES_PAGE_SCRIPT_POLICY__) {
      globalThis.__HERMES_PAGE_SCRIPT_POLICY__ = {
        likelyPrivate: false,
        decided: false,
        latestInject: null,
        policySeq: 0,
        policyLocationToken: null,
      };
    }
    if (typeof globalThis.__HERMES_PAGE_SCRIPT_POLICY__.policySeq !== 'number') {
      globalThis.__HERMES_PAGE_SCRIPT_POLICY__.policySeq = 0;
    }
    return globalThis.__HERMES_PAGE_SCRIPT_POLICY__;
  }

  function policyDecisionFreshForLocation(gate) {
    const current = pageScriptPolicyLocationToken();
    if (!current) return typeof gate.latestInject === 'boolean';
    if (!gate.policyLocationToken) return typeof gate.latestInject === 'boolean';
    return gate.policyLocationToken === current;
  }

  function publishPendingPolicyPromise(gate) {
    gate.decided = false;
    gate.latestInject = null;
    gate.policyLocationToken = null;
    gate.allowLocalDocuments = false;
    let resolvePending;
    gate.promise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    gate._resolvePendingPolicy = resolvePending;
  }

  function settlePendingPolicyPromise(gate, inject) {
    if (typeof gate._resolvePendingPolicy === 'function') {
      gate._resolvePendingPolicy(inject);
      delete gate._resolvePendingPolicy;
    }
  }

  function denyLatestPolicyRefresh(gate, requestSeq) {
    if (requestSeq !== gate.policySeq) return;
    if (typeof gate._resolvePendingPolicy !== 'function') return;
    globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
    gate.latestInject = false;
    gate.decided = true;
    gate.policyLocationToken = pageScriptPolicyLocationToken();
    settlePendingPolicyPromise(gate, false);
    gate.promise = Promise.resolve(false);
  }

  function invalidatePolicyForLocationMismatch(gate) {
    globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
    publishPendingPolicyPromise(gate);
    try {
      const refresh = globalThis.hermesRefreshPageScriptPolicy;
      if (typeof refresh === 'function') void refresh();
    } catch {
      /* remain blocked */
    }
  }

  function nextPageScriptPolicySeq(gate) {
    gate.policySeq = (gate.policySeq || 0) + 1;
    return gate.policySeq;
  }

  function applyPageScriptPolicyResponse(gate, response) {
    if (response && response.seq != null && response.seq !== gate.policySeq) {
      return null;
    }
    const inject = response && typeof response.inject === 'boolean' ? response.inject : false;
    gate.allowLocalDocuments = Boolean(response && response.allowLocalDocuments);
    const wasBlocked = globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ === true;
    const priorInject = typeof gate.latestInject === 'boolean' ? gate.latestInject : null;
    globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !inject;
    gate.latestInject = inject;
    gate.decided = true;
    gate.policyLocationToken = pageScriptPolicyLocationToken();
    settlePendingPolicyPromise(gate, inject);
    gate.promise = Promise.resolve(inject);
    if (gate._resolvePolicy) gate._resolvePolicy(inject);
    if (inject && (priorInject === false || (priorInject === null && wasBlocked))) {
      globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__ = true;
    }
    if (inject) notifyPolicyDecision(true);
    return inject;
  }

  function pageScriptPolicyPromise() {
    const gate = ensurePageScriptPolicyRecord();
    const currentToken = pageScriptPolicyLocationToken();
    if (currentToken && gate.policyLocationToken && gate.policyLocationToken !== currentToken) {
      invalidatePolicyForLocationMismatch(gate);
      return gate.promise;
    }
    if (typeof gate.latestInject === 'boolean' && policyDecisionFreshForLocation(gate)) {
      return Promise.resolve(gate.latestInject);
    }
    if (gate.decided && policyDecisionFreshForLocation(gate)) {
      return Promise.resolve(!globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__);
    }
    if (gate.promise) {
      return gate.promise.then((initial) => (
        typeof gate.latestInject === 'boolean' && policyDecisionFreshForLocation(gate)
          ? gate.latestInject
          : initial
      ));
    }
    if (globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__) {
      publishPendingPolicyPromise(gate);
      try {
        const refresh = globalThis.hermesRefreshPageScriptPolicy;
        if (typeof refresh === 'function') void refresh();
      } catch {
        /* stay on pending promise */
      }
      return gate.promise;
    }
    return Promise.resolve(true);
  }

  globalThis.hermesPageScriptPolicyPromise = pageScriptPolicyPromise;
  globalThis.hermesAwaitPageScriptPolicy = function hermesAwaitPageScriptPolicy(continueFn) {
    pageScriptPolicyPromise().then((inject) => {
      if (inject) continueFn();
      else if (typeof continueFn === 'function') deferredRuns().push(continueFn);
    });
  };

  globalThis.hermesRefreshPageScriptPolicy = function hermesRefreshPageScriptPolicy() {
    const browserApi = globalThis.browser || globalThis.chrome;
    if (!browserApi?.runtime?.sendMessage) return Promise.resolve(false);
    const gate = ensurePageScriptPolicyRecord();
    const awaitingReply = typeof gate._resolvePendingPolicy === 'function';
    if (!awaitingReply && (!policyDecisionFreshForLocation(gate) || gate.latestInject == null)) {
      publishPendingPolicyPromise(gate);
    }
    const requestSeq = nextPageScriptPolicySeq(gate);
    const message = { type: 'HERMES_PAGE_SCRIPT_POLICY', url: location.href, seq: requestSeq };
    const settleRefresh = (response) => {
      const inject = applyPageScriptPolicyResponse(gate, response);
      if (inject == null) return pageScriptPolicyPromise();
      return inject;
    };
    return new Promise((resolve) => {
      try {
        if (typeof globalThis.browser?.runtime?.sendMessage === 'function') {
          Promise.resolve(globalThis.browser.runtime.sendMessage(message))
            .then((response) => Promise.resolve(settleRefresh(response)).then(resolve))
            .catch(() => {
              denyLatestPolicyRefresh(gate, requestSeq);
              resolve(false);
            });
        } else {
          browserApi.runtime.sendMessage(message, (response) => {
            if (browserApi.runtime.lastError) {
              denyLatestPolicyRefresh(gate, requestSeq);
              resolve(false);
              return;
            }
            Promise.resolve(settleRefresh(response)).then(resolve);
          });
        }
      } catch {
        denyLatestPolicyRefresh(gate, requestSeq);
        resolve(false);
      }
    });
  };

  function resetBundleGatePolicyForCurrentLocation() {
    const reinject = Boolean(
      globalThis.__HERMES_BROWSER_CONTENT_LOADED__
      || globalThis.HermesContentExtractor
      || globalThis.__HERMES_PAGE_SCRIPT_BUNDLE_RESTART__ === true,
    );
    if (!reinject) return false;
    globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
    const gate = ensurePageScriptPolicyRecord();
    publishPendingPolicyPromise(gate);
    return true;
  }

  if (resetBundleGatePolicyForCurrentLocation()) {
    try {
      const refresh = globalThis.hermesRefreshPageScriptPolicy;
      if (typeof refresh === 'function') void refresh();
    } catch {
      /* stay blocked until a later refresh succeeds */
    }
  }
})();
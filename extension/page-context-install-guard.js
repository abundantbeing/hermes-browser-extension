/* Generated from extension/lib/common.mjs privateNetworkHost. Do not edit directly. */
(() => {
  'use strict';
  const browserApi = globalThis.browser || globalThis.chrome;
  if (!browserApi?.runtime?.sendMessage) return;

  const privateNetworkHost = function privateNetworkHost(host = '') {
  const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return true;
  if (/^(fc|fd)[0-9a-f]{2}:|^fe80:/.test(name)) return true;
  const ipv4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (/\.(local|lan|internal|home\.arpa|ts\.net)$/.test(name)) return true;
  return !name.includes('.') && !name.includes(':');
};

  const likelyPrivate = privateNetworkHost(location.hostname);
  if (likelyPrivate) globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
  let settled = false;

  const promise = new Promise((resolve) => {
    const finish = (inject) => {
      if (settled) return;
      settled = true;
      globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !inject;
      resolve(Boolean(inject));
    };

    const timeout = setTimeout(() => finish(!likelyPrivate), 4000);

    const onDecision = (response) => {
      clearTimeout(timeout);
      if (response && typeof response.inject === 'boolean') finish(response.inject);
      else finish(!likelyPrivate);
    };

    const fail = () => finish(!likelyPrivate);
    const message = { type: 'HERMES_PAGE_SCRIPT_POLICY', url: location.href };

    try {
      if (typeof globalThis.browser?.runtime?.sendMessage === 'function') {
        Promise.resolve(globalThis.browser.runtime.sendMessage(message)).then(onDecision).catch(fail);
      } else {
        browserApi.runtime.sendMessage(message, (response) => {
          if (browserApi.runtime.lastError) fail();
          else onDecision(response);
        });
      }
    } catch {
      fail();
    }
  });

  globalThis.__HERMES_PAGE_SCRIPT_POLICY__ = { promise, likelyPrivate };
})();

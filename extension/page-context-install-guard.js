/* Generated from extension/lib/common.mjs privateNetworkHost. Do not edit directly. */
(() => {
  'use strict';
  const browserApi = globalThis.browser || globalThis.chrome;
  if (!browserApi?.runtime?.sendMessage) return;

  const privateNetworkHost = function privateNetworkHost(host = '') {
  const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(name)) return true;
  if (name.includes(':')) {
    const mapped = name.match(/^::ffff:([0-9a-f:.]+)$/i);
    if (mapped) {
      const tail = mapped[1];
      const dotted = tail.match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
      if (dotted) return privateNetworkHost(dotted[1]);
      const parts = tail.split(':').filter(Boolean);
      if (parts.length && parts.length <= 2) {
        const hi = Number.parseInt(parts[0], 16);
        const lo = Number.parseInt(parts[1] || '0', 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          const packed = (hi << 16) + lo;
          const ipv4 = `${(packed >>> 24) & 255}.${(packed >>> 16) & 255}.${(packed >>> 8) & 255}.${packed & 255}`;
          if (privateNetworkHost(ipv4)) return true;
        }
      }
    }
    const head = name.split(':').find((part) => part.length > 0) || '';
    const value = head ? Number.parseInt(head, 16) : NaN;
    if (Number.isFinite(value) && value >= 0xfe80 && value <= 0xfebf) return true;
    if (!head && /^fe[89ab]/i.test(name)) return true;
  }
  const ipv4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4])];
    if (a === 0 && b === 0 && c === 0 && d === 0) return true;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (/\.(local|lan|internal|home\.arpa|ts\.net)$/.test(name)) return true;
  return !name.includes('.') && !name.includes(':');
};

  const likelyPrivate = privateNetworkHost(location.hostname);
  globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;

  const gate = { likelyPrivate, decided: false, latestInject: null, policySeq: 0 };
  gate.promise = new Promise((resolve) => {
    gate._resolvePolicy = (inject) => {
      const allow = Boolean(inject);
      globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = !allow;
      gate.latestInject = allow;
      if (!gate.decided) {
        gate.decided = true;
        resolve(allow);
      }
      if (allow && typeof globalThis.__hermesPageScriptPolicyDecided === 'function') {
        globalThis.__hermesPageScriptPolicyDecided(allow);
      }
    };

    const finish = (inject) => gate._resolvePolicy(inject);

    const timeout = setTimeout(() => {
      /* fail closed: stay blocked until an authoritative inject decision arrives */
    }, 4000);

    const requestSeq = (gate.policySeq = (gate.policySeq || 0) + 1);

    const onDecision = (response) => {
      clearTimeout(timeout);
      if (response && response.seq != null && response.seq !== gate.policySeq) return;
      if (response && typeof response.inject === 'boolean') finish(response.inject);
    };

    const fail = () => {
      /* fail closed: messaging failure leaves scripts blocked */
    };

    const message = { type: 'HERMES_PAGE_SCRIPT_POLICY', url: location.href, seq: requestSeq };

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

  globalThis.__HERMES_PAGE_SCRIPT_POLICY__ = gate;
})();

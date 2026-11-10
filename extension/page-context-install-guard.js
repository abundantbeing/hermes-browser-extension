(() => {
  const browserApi = globalThis.browser || globalThis.chrome;
  if (!browserApi?.runtime?.sendMessage) return;

  function privateNetworkHost(hostname = '') {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return true;
    if (host.endsWith('.localhost')) return true;
    if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
    if (host.endsWith('.home.arpa') || host.endsWith('.ts.net')) return true;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (a === 10) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
    }
    return false;
  }

  if (privateNetworkHost(location.hostname)) {
    globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = true;
  }

  browserApi.runtime.sendMessage(
    { type: 'HERMES_PAGE_SCRIPT_POLICY', url: location.href },
    (response) => {
      if (browserApi.runtime.lastError) return;
      globalThis.__HERMES_PAGE_SCRIPTS_BLOCKED__ = response?.inject === false;
    },
  );
})();

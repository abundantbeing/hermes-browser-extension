// Loopback gateway URLs panels register while pairing before the address is saved. Each attempt
// registers and later releases its own hold; the worker applies every pending URL to rule 7747.

export function trimPendingGatewayUrl(value) {
  return typeof value === 'string' ? value.slice(0, 2048).trim() : '';
}

export function createPendingPairingGatewayUrlRegistry({ normalize = trimPendingGatewayUrl } = {}) {
  const counts = new Map();

  function register(url) {
    const key = normalize(url);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  function release(url) {
    const key = normalize(url);
    if (!key) return;
    const next = (counts.get(key) || 0) - 1;
    if (next <= 0) counts.delete(key);
    else counts.set(key, next);
  }

  function clear() {
    counts.clear();
  }

  function list() {
    return [...counts.keys()];
  }

  function applySyncMessage(message) {
    const releaseUrl = trimPendingGatewayUrl(message?.releasePendingGatewayUrl);
    if (releaseUrl) release(releaseUrl);
    const pendingUrl = trimPendingGatewayUrl(message?.pendingGatewayUrl);
    if (!pendingUrl) return;
    if (message?.pendingGatewayUrlAction === 'release') release(pendingUrl);
    else register(pendingUrl);
  }

  return { register, release, clear, list, applySyncMessage };
}
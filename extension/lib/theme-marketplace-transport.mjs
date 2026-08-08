import { HERMES_THEME_MARKETPLACE_INSTALL } from './theme-marketplace-controller.mjs';

const DIRECT_INSTALL_LOCK = 'hermes-theme-marketplace-install';

function isMarketplaceResponse(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.ok === 'boolean';
}

export function createThemeMarketplaceTransport({
  runtime,
  fallbackController,
  locks = globalThis.navigator?.locks,
} = {}) {
  if (!runtime || typeof runtime.sendMessage !== 'function') throw new TypeError('runtime.sendMessage is required');
  if (!fallbackController || typeof fallbackController.handleMessage !== 'function') {
    throw new TypeError('fallbackController.handleMessage is required');
  }

  async function direct(message) {
    if (!fallbackController.handles?.(message?.type)) {
      return { ok: false, error: { code: 'unsupported-message', message: 'Unsupported Marketplace message' } };
    }
    if (message.type === HERMES_THEME_MARKETPLACE_INSTALL && typeof locks?.request === 'function') {
      return locks.request(DIRECT_INSTALL_LOCK, { mode: 'exclusive' }, () => fallbackController.handleMessage(message));
    }
    return fallbackController.handleMessage(message);
  }

  return Object.freeze({
    async send(message) {
      try {
        const response = await runtime.sendMessage(message);
        if (isMarketplaceResponse(response)) return response;
      } catch {
        // An unpacked extension can refresh its page before Chromium replaces
        // the service worker. Continue through the same validated client/store
        // contract instead of presenting a false permanent outage.
      }
      return direct(message);
    },
  });
}

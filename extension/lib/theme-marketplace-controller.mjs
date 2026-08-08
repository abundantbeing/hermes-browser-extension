import { installCustomTheme, readCustomThemeStore } from './custom-theme-store.mjs';

export const HERMES_THEME_MARKETPLACE_SEARCH = 'HERMES_THEME_MARKETPLACE_SEARCH';
export const HERMES_THEME_MARKETPLACE_INSTALL = 'HERMES_THEME_MARKETPLACE_INSTALL';
const TYPES = new Set([HERMES_THEME_MARKETPLACE_SEARCH, HERMES_THEME_MARKETPLACE_INSTALL]);
const ID_RE = /^[\w-]+\.[\w-]+$/;

function safeError(error) {
  const rawCode = typeof error?.code === 'string' && /^[a-z0-9-]+$/.test(error.code) ? error.code : 'marketplace-failed';
  const corruptCodes = new Set([
    'archive-invalid', 'archive-truncated', 'end-record-missing', 'end-record-duplicate', 'end-record-invalid',
    'central-directory-bounds', 'central-signature', 'central-directory-size', 'local-signature', 'local-name-mismatch',
    'local-header-mismatch', 'payload-bounds', 'crc-mismatch', 'size-mismatch', 'deflate-failed', 'entry-name-encoding',
    'invalid-entry-path', 'manifest-invalid', 'theme-path-invalid', 'theme-file-missing', 'theme-encoding',
  ]);
  const code = corruptCodes.has(rawCode) ? 'package-corrupt' : rawCode;
  const messages = {
    'request-timeout': 'Marketplace request timed out',
    'archive-too-large': 'Marketplace package is too large',
    'package-too-large': 'Marketplace package manifest is too large',
    'theme-too-large': 'Marketplace theme file is too large',
    'no-color-themes': 'Package is not a supported color theme',
    'package-corrupt': 'Marketplace package is corrupt',
    'unsupported-compression': 'Marketplace package uses an unsupported archive format',
    'network-failed': 'Marketplace is unavailable',
  };
  return { ok: false, error: { code, message: messages[code] || 'Marketplace request could not be completed' } };
}

export function createThemeMarketplaceController({
  client,
  storageArea,
  readStore = readCustomThemeStore,
  installTheme = installCustomTheme,
  randomUUID,
  now,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!client || typeof client.search !== 'function' || typeof client.install !== 'function') {
    throw new TypeError('Marketplace client must expose search and install');
  }
  if (!storageArea) throw new TypeError('storageArea is required');

  const installTransactions = new Map();
  let installQueue = Promise.resolve();

  async function searchWithRetry(query, options) {
    try {
      return await client.search(query, options);
    } catch (error) {
      if (!['network-failed', 'request-timeout'].includes(error?.code)) throw error;
      await wait(250);
      return client.search(query, options);
    }
  }

  async function installOne(extensionId) {
    try {
      const store = await readStore(storageArea);
      if (!store.ok) return safeError(Object.assign(new Error(), { code: store.error?.code || 'storage-read-failed' }));
      const existing = store.themes.find((record) => (
        record.source === 'vscode-marketplace'
        && String(record.sourceId || '').toLowerCase() === extensionId
      ));
      if (existing) {
        return { ok: true, data: { themeId: existing.id, extensionId, displayName: existing.document.name, variantCount: existing.document.darkColors ? 2 : 1, derived: [], adjusted: [], existing: true } };
      }
      const converted = await client.install(extensionId, { installedRecords: store.themes });
      if (converted.existingThemeId) return { ok: true, data: { themeId: converted.existingThemeId, extensionId, existing: true } };
      const installed = await installTheme(storageArea, converted.document, {
        source: 'vscode-marketplace',
        sourceId: converted.extensionId,
        sourceVersion: converted.sourceVersion,
        randomUUID,
        now,
      });
      if (!installed.ok) return safeError(Object.assign(new Error(), { code: installed.error?.code || 'storage-write-failed' }));
      return {
        ok: true,
        data: {
          themeId: installed.record.id,
          extensionId: converted.extensionId,
          displayName: converted.displayName,
          variantCount: converted.variantCount,
          derived: Array.isArray(converted.derived) ? converted.derived : [],
          adjusted: Array.isArray(converted.adjusted) ? converted.adjusted : [],
          existing: false,
        },
      };
    } catch (error) {
      return safeError(error);
    }
  }

  function installSerialized(extensionId) {
    const current = installTransactions.get(extensionId);
    if (current) return current;
    const transaction = installQueue.then(() => installOne(extensionId));
    installQueue = transaction.catch(() => {});
    installTransactions.set(extensionId, transaction);
    transaction.finally(() => {
      if (installTransactions.get(extensionId) === transaction) installTransactions.delete(extensionId);
    });
    return transaction;
  }

  return Object.freeze({
    handles(type) { return TYPES.has(type); },
    async handleMessage(message) {
      if (!TYPES.has(message?.type)) return { ok: false, error: { code: 'unsupported-message', message: 'Unsupported Marketplace message' } };
      try {
        if (message.type === HERMES_THEME_MARKETPLACE_SEARCH) {
          if (typeof message.query !== 'string' || message.query.length > 200) return safeError(Object.assign(new Error(), { code: 'invalid-request' }));
          const limit = Number(message.limit ?? 20);
          if (!Number.isInteger(limit) || limit < 1 || limit > 20) return safeError(Object.assign(new Error(), { code: 'invalid-request' }));
          const store = await readStore(storageArea);
          if (!store.ok) return safeError(Object.assign(new Error(), { code: store.error?.code || 'storage-read-failed' }));
          const data = await searchWithRetry(message.query, { limit, installedRecords: store.themes });
          return { ok: true, data: structuredClone(data) };
        }

        if (typeof message.extensionId !== 'string' || !ID_RE.test(message.extensionId.trim())) {
          return safeError(Object.assign(new Error(), { code: 'invalid-extension-id' }));
        }
        return await installSerialized(message.extensionId.trim().toLowerCase());
      } catch (error) {
        return safeError(error);
      }
    },
  });
}

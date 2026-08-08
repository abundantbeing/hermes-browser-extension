import { buildVscodeThemeFamily } from './vscode-theme-convert.mjs';
import { extractVsixThemes } from './vsix-theme-extractor.mjs';

const GALLERY_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const VSIX_ASSET_TYPE = 'Microsoft.VisualStudio.Services.VSIXPackage';
const EXTENSION_ID_RE = /^[\w-]+\.[\w-]+$/;

export const MARKETPLACE_LIMITS = Object.freeze({
  timeoutMs: 20_000,
  galleryBytes: 4 * 1024 * 1024,
  vsixBytes: 20 * 1024 * 1024,
  renderResults: 20,
  queryResults: 40,
});

function marketplaceError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function readBounded(response, cap, code, signal) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw marketplaceError(code, 'Marketplace response exceeds the byte limit');
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > cap) throw marketplaceError(code, 'Marketplace response exceeds the byte limit');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const aborted = signal
    ? new Promise((_, reject) => {
      if (signal.aborted) reject(marketplaceError('request-timeout', 'Marketplace request timed out'));
      else signal.addEventListener('abort', () => reject(marketplaceError('request-timeout', 'Marketplace request timed out')), { once: true });
    })
    : null;
  while (true) {
    const read = reader.read();
    const { done, value } = await (aborted ? Promise.race([read, aborted]) : read);
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw marketplaceError(code, 'Marketplace response exceeds the byte limit');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function queryPayload(query, pageSize, exact = false) {
  const criteria = exact
    ? [{ filterType: 7, value: query }]
    : [
      { filterType: 8, value: 'Microsoft.VisualStudio.Code' },
      { filterType: 5, value: 'Themes' },
      { filterType: 12, value: '4096' },
      ...(query ? [{ filterType: 10, value: query }] : []),
    ];
  return {
    filters: [{ criteria, pageNumber: 1, pageSize, sortBy: 4, sortOrder: 0 }],
    assetTypes: [],
    flags: 914,
  };
}

function looksLikeIconTheme(extension) {
  const tags = Array.isArray(extension?.tags) ? extension.tags.join(' ') : '';
  const text = `${extension?.displayName || ''} ${extension?.shortDescription || ''} ${tags}`.toLowerCase();
  return /\b(icon theme|file icons?|product icons?|icon pack|fileicons)\b/.test(text);
}

function extensionId(extension) {
  const publisher = extension?.publisher?.publisherName || extension?.publisher?.displayName || '';
  const name = extension?.extensionName || '';
  return `${publisher}.${name}`;
}

function galleryRows(json) {
  const rows = json?.results?.[0]?.extensions;
  if (!Array.isArray(rows)) throw marketplaceError('gallery-shape', 'Marketplace returned an invalid response shape');
  return rows;
}

function cardFor(extension, installedRecords) {
  const id = extensionId(extension);
  if (!EXTENSION_ID_RE.test(id)) return null;
  const statistic = Array.isArray(extension.statistics)
    ? extension.statistics.find((item) => item?.statisticName === 'install')
    : null;
  const installed = installedRecords.find((record) => record?.source === 'vscode-marketplace' && record?.sourceId === id);
  return {
    extensionId: id,
    displayName: String(extension.displayName || extension.extensionName || id),
    publisher: String(extension.publisher?.displayName || extension.publisher?.publisherName || ''),
    description: String(extension.shortDescription || ''),
    installs: Math.max(0, Math.round(Number(statistic?.value) || 0)),
    installedThemeId: installed?.id || null,
  };
}

function validateVsixUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw marketplaceError('vsix-url-invalid', 'Marketplace package URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw marketplaceError('vsix-url-invalid', 'Marketplace package URL is not permitted');
  const host = url.hostname.toLowerCase();
  if (host !== 'marketplace.visualstudio.com' && !host.endsWith('.vsassets.io')) {
    throw marketplaceError('vsix-host-unreviewed', 'Marketplace package host is not permitted');
  }
  return url.href;
}

function validateGalleryUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw marketplaceError('gallery-url-invalid', 'Marketplace response URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname.toLowerCase() !== 'marketplace.visualstudio.com') {
    throw marketplaceError('gallery-url-invalid', 'Marketplace response URL is not permitted');
  }
  return url.href;
}

export function createVscodeMarketplaceClient({
  fetchImpl = globalThis.fetch,
  extractImpl = extractVsixThemes,
  convertImpl = buildVscodeThemeFamily,
  timeoutMs = MARKETPLACE_LIMITS.timeoutMs,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  async function request(url, options, cap, capCode, validateFinalUrl, redirect = 'error') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, credentials: 'omit', redirect });
      if (!response?.ok) throw marketplaceError('gallery-http', 'Marketplace request returned an HTTP error');
      validateFinalUrl?.(response.url || url);
      return await readBounded(response, cap, capCode, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'request-timeout') {
        throw marketplaceError('request-timeout', 'Marketplace request timed out');
      }
      if (error?.code) throw error;
      throw marketplaceError('network-failed', 'Marketplace request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async function galleryQuery(payload) {
    const bytes = await request(GALLERY_URL, {
      method: 'POST',
      headers: { Accept: 'application/json;api-version=7.2-preview.1', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, MARKETPLACE_LIMITS.galleryBytes, 'response-too-large', validateGalleryUrl);
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw marketplaceError('gallery-json', 'Marketplace returned malformed JSON'); }
  }

  return Object.freeze({
    async search(query = '', { limit = MARKETPLACE_LIMITS.renderResults, installedRecords = [] } = {}) {
      const text = String(query || '').trim().slice(0, 200);
      const renderLimit = Math.max(1, Math.min(MARKETPLACE_LIMITS.renderResults, Number(limit) || MARKETPLACE_LIMITS.renderResults));
      const json = await galleryQuery(queryPayload(text, MARKETPLACE_LIMITS.queryResults));
      const results = galleryRows(json)
        .filter((extension) => !looksLikeIconTheme(extension))
        .map((extension) => cardFor(extension, Array.isArray(installedRecords) ? installedRecords : []))
        .filter(Boolean)
        .slice(0, renderLimit);
      return { results };
    },

    async install(id, { installedRecords = [] } = {}) {
      const normalizedId = String(id || '').trim().toLowerCase();
      if (!EXTENSION_ID_RE.test(normalizedId)) throw marketplaceError('invalid-extension-id', 'Marketplace extension ID is invalid');
      const existing = (Array.isArray(installedRecords) ? installedRecords : [])
        .find((record) => record?.source === 'vscode-marketplace' && String(record?.sourceId || '').toLowerCase() === normalizedId);
      if (existing) return { existingThemeId: existing.id, extensionId: normalizedId };

      const json = await galleryQuery(queryPayload(normalizedId, 1, true));
      const extension = galleryRows(json).find((item) => extensionId(item).toLowerCase() === normalizedId.toLowerCase());
      if (!extension) throw marketplaceError('extension-not-found', 'Marketplace extension was not found');
      const version = extension.versions?.[0];
      const asset = version?.files?.find((file) => file?.assetType === VSIX_ASSET_TYPE);
      if (!asset?.source) throw marketplaceError('vsix-asset-missing', 'Marketplace extension has no downloadable VSIX package');
      const vsixUrl = validateVsixUrl(asset.source);
      const archive = await request(
        vsixUrl,
        { method: 'GET' },
        MARKETPLACE_LIMITS.vsixBytes,
        'archive-too-large',
        validateVsixUrl,
        'follow',
      );
      let extracted;
      try { extracted = await extractImpl(archive); }
      catch (error) { throw marketplaceError(error?.code || 'package-corrupt', 'Marketplace theme package could not be read'); }
      let converted;
      try {
        converted = convertImpl(extracted.themes, {
          displayName: extension.displayName || normalizedId,
          sourceId: normalizedId,
        });
      } catch (error) {
        throw marketplaceError(error?.code || 'theme-conversion-failed', 'Marketplace theme could not be converted');
      }
      return {
        extensionId: normalizedId,
        displayName: String(extension.displayName || normalizedId),
        sourceVersion: String(version?.version || extracted.packageVersion || ''),
        ...converted,
      };
    },
  });
}

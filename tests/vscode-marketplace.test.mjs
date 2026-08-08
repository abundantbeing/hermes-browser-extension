import assert from 'node:assert/strict';
import test from 'node:test';
import { createVscodeMarketplaceClient, MARKETPLACE_LIMITS } from '../extension/lib/vscode-marketplace.mjs';

const galleryExtension = (overrides = {}) => ({
  extensionName: 'theme-dracula', displayName: 'Dracula', shortDescription: 'A dark color theme',
  publisher: { publisherName: 'dracula-theme', displayName: 'Dracula Theme' },
  statistics: [{ statisticName: 'install', value: 12345 }], tags: ['Themes'],
  versions: [{ version: '1.0.0', files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: 'https://x.vsassets.io/demo.vsix' }] }],
  ...overrides,
});
const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const binaryResponse = (bytes, status = 200, headers = {}) => new Response(bytes, { status, headers });
const gallery = (extensions) => ({ results: [{ extensions }] });

function client(fetchImpl, extra = {}) {
  return createVscodeMarketplaceClient({
    fetchImpl,
    extractImpl: async () => ({ packageVersion: '1.0.0', themes: [{ label: 'Demo', uiTheme: 'vs-dark', contents: '{"colors":{}}' }] }),
    convertImpl: () => ({ document: { schemaVersion: 1 }, variantCount: 1, derived: [], adjusted: [] }),
    ...extra,
  });
}

test('search sends the target/category/exclude criteria and most-installed ordering for empty query', async () => {
  let request;
  const result = await client(async (url, options) => { request = { url, options }; return jsonResponse(gallery([galleryExtension()])); }).search('');
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.credentials, 'omit');
  assert.deepEqual(body.filters[0].criteria.map((item) => item.filterType), [8, 5, 12]);
  assert.equal(body.filters[0].sortBy, 4);
  assert.equal(result.results[0].extensionId, 'dracula-theme.theme-dracula');
});

test('text search adds SearchText and normalizes cards with installed IDs', async () => {
  let body;
  const result = await client(async (_url, options) => { body = JSON.parse(options.body); return jsonResponse(gallery([galleryExtension()])); })
    .search('dracula', { installedRecords: [{ id: 'custom:1', source: 'vscode-marketplace', sourceId: 'dracula-theme.theme-dracula' }] });
  assert.equal(body.filters[0].criteria.at(-1).filterType, 10);
  assert.equal(result.results[0].installedThemeId, 'custom:1');
  assert.equal(result.results[0].installs, 12345);
});

test('search filters obvious icon-only packages and caps rendered results', async () => {
  const rows = Array.from({ length: 30 }, (_, index) => galleryExtension({ extensionName: `t${index}`, displayName: index === 0 ? 'File Icon Theme' : `Theme ${index}` }));
  const result = await client(async () => jsonResponse(gallery(rows))).search('', { limit: 20 });
  assert.equal(result.results.length, 20);
  assert.ok(result.results.every((row) => !/icon/i.test(row.displayName)));
});

test('search rejects HTTP errors, malformed JSON shape, and oversized responses', async () => {
  await assert.rejects(() => client(async () => jsonResponse({}, 500)).search('x'), (e) => e.code === 'gallery-http');
  await assert.rejects(() => client(async () => jsonResponse({ nope: true })).search('x'), (e) => e.code === 'gallery-shape');
  await assert.rejects(() => client(async () => jsonResponse(gallery([]), 200, { 'content-length': String(MARKETPLACE_LIMITS.galleryBytes + 1) })).search('x'), (e) => e.code === 'response-too-large');
});

test('install validates exact IDs and returns an existing source without network work', async () => {
  const c = client(async () => { throw new Error('must not fetch'); });
  await assert.rejects(() => c.install('bad id'), (e) => e.code === 'invalid-extension-id');
  const result = await c.install('demo.theme', { installedRecords: [{ id: 'custom:existing', source: 'vscode-marketplace', sourceId: 'demo.theme' }] });
  assert.equal(result.existingThemeId, 'custom:existing');
});

test('install resolves exact ID, enforces HTTPS allowlist, downloads, extracts, and converts', async () => {
  const calls = [];
  const result = await client(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return jsonResponse(gallery([galleryExtension()]));
    return binaryResponse(new Uint8Array([1, 2, 3]));
  }).install('dracula-theme.theme-dracula');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, 'error', 'Gallery requests must not follow redirects');
  assert.equal(calls[1].options.redirect, 'follow', 'VSIX downloads must follow the Marketplace CDN hop');
  assert.equal(result.extensionId, 'dracula-theme.theme-dracula');
  assert.equal(result.sourceVersion, '1.0.0');
  assert.equal(result.variantCount, 1);
  assert.deepEqual(result.document, { schemaVersion: 1 });
});

test('install accepts an allowed Marketplace CDN final URL after the VSIX redirect', async () => {
  let call = 0;
  const result = await client(async (_url, options) => {
    call += 1;
    if (call === 1) return jsonResponse(gallery([galleryExtension()]));
    assert.equal(options.redirect, 'follow');
    const response = binaryResponse(new Uint8Array([1, 2, 3]));
    Object.defineProperty(response, 'url', { value: 'https://cdn.example.vsassets.io/redirected.vsix' });
    return response;
  }).install('dracula-theme.theme-dracula');
  assert.equal(result.extensionId, 'dracula-theme.theme-dracula');
});

test('install rejects missing assets, non-HTTPS URLs, unreviewed hosts, and archive caps', async () => {
  await assert.rejects(() => client(async () => jsonResponse(gallery([galleryExtension({ versions: [{ version: '1', files: [] }] })]))).install('dracula-theme.theme-dracula'), (e) => e.code === 'vsix-asset-missing');
  for (const source of ['http://x.vsassets.io/x', 'https://evil.example/x', 'https://user:pass@x.vsassets.io/x']) {
    await assert.rejects(() => client(async () => jsonResponse(gallery([galleryExtension({ versions: [{ version: '1', files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source }] }] })]))).install('dracula-theme.theme-dracula'));
  }
  let count = 0;
  await assert.rejects(() => client(async () => (++count === 1
    ? jsonResponse(gallery([galleryExtension()]))
    : binaryResponse(new Uint8Array(), 200, { 'content-length': String(MARKETPLACE_LIMITS.vsixBytes + 1) }))).install('dracula-theme.theme-dracula'), (e) => e.code === 'archive-too-large');
});

test('request timeout remains active while the response body is streaming', async () => {
  const stalledResponse = {
    ok: true,
    url: 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
    headers: new Headers(),
    body: {
      getReader() {
        return {
          read() { return new Promise(() => {}); },
          async cancel() {},
        };
      },
    },
  };
  const operation = client(async () => stalledResponse, { timeoutMs: 10 }).search('stalled');
  await assert.rejects(
    Promise.race([
      operation,
      new Promise((_, reject) => setTimeout(() => reject(new Error('test-timeout')), 150)),
    ]),
    (error) => error?.code === 'request-timeout',
  );
});

test('install rejects a VSIX response redirected to an unreviewed final host', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return jsonResponse(gallery([galleryExtension()]));
    const response = binaryResponse(new Uint8Array([1, 2, 3]));
    Object.defineProperty(response, 'url', { value: 'https://evil.example/redirected.vsix' });
    return response;
  };
  await assert.rejects(
    () => client(fetchImpl).install('dracula-theme.theme-dracula'),
    (error) => error?.code === 'vsix-host-unreviewed',
  );
});

test('errors are structured and never expose response bodies or archive bytes', async () => {
  await assert.rejects(() => client(async () => new Response('super-secret-body', { status: 502 })).search('x'), (error) => {
    assert.equal(error.code, 'gallery-http');
    assert.doesNotMatch(error.message, /super-secret-body/);
    assert.equal(Object.hasOwn(error, 'body'), false);
    return true;
  });
});

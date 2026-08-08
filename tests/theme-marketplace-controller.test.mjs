import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HERMES_THEME_MARKETPLACE_INSTALL,
  HERMES_THEME_MARKETPLACE_SEARCH,
  createThemeMarketplaceController,
} from '../extension/lib/theme-marketplace-controller.mjs';
import { CUSTOM_THEME_STORAGE_KEY, normalizeThemeDocument } from '../extension/lib/custom-themes.mjs';

function storage(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    async get(key) { return Object.hasOwn(state, key) ? { [key]: structuredClone(state[key]) } : {}; },
    async set(values) { Object.assign(state, structuredClone(values)); },
    async remove(key) { delete state[key]; },
  };
}

const document = {
  schemaVersion: 1, name: 'Marketplace Demo', description: 'VS Code · demo.theme',
  colors: { canvas:'#ffffff',paper:'#f5f5f5',ink:'#111111',muted:'#595959',primary:'#0505e8',primaryDeep:'#03039b',onPrimary:'#ffffff',accent:'#ffd400',onAccent:'#111111',line:'#767676',input:'#ffffff',danger:'#b00020',onDanger:'#ffffff',shellForeground:'#ffffff' },
  darkColors: { canvas:'#101114',paper:'#181a20',ink:'#f4f5f7',muted:'#b5bac4',primary:'#4c59e8',primaryDeep:'#343db8',onPrimary:'#ffffff',accent:'#e6ff57',onAccent:'#101114',line:'#777d8a',input:'#101114',danger:'#ff6b78',onDanger:'#101114',shellForeground:'#ffffff' },
};

const clientStub = (overrides = {}) => ({
  async search() { return { results: [] }; },
  async install() { throw new Error('not implemented'); },
  ...overrides,
});

test('controller recognizes only the two typed Marketplace messages', () => {
  const controller = createThemeMarketplaceController({ client: clientStub(), storageArea: storage() });
  assert.equal(controller.handles(HERMES_THEME_MARKETPLACE_SEARCH), true);
  assert.equal(controller.handles(HERMES_THEME_MARKETPLACE_INSTALL), true);
  assert.equal(controller.handles('OTHER'), false);
});

test('search validates shape, reads installed records, and returns serializable results', async () => {
  let options;
  const controller = createThemeMarketplaceController({
    storageArea: storage(),
    client: clientStub({ async search(query, value) { options = { query, ...value }; return { results: [{ extensionId: 'demo.theme' }] }; } }),
  });
  assert.equal((await controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_SEARCH, query: {}, limit: 20 })).ok, false);
  const result = await controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_SEARCH, query: 'demo', limit: 20 });
  assert.deepEqual(result, { ok: true, data: { results: [{ extensionId: 'demo.theme' }] } });
  assert.equal(options.query, 'demo');
  assert.deepEqual(options.installedRecords, []);
});

test('search retries one transient Marketplace failure before returning unavailable', async () => {
  let attempts = 0;
  const waits = [];
  const controller = createThemeMarketplaceController({
    storageArea: storage(),
    wait: async (milliseconds) => { waits.push(milliseconds); },
    client: clientStub({
      async search() {
        attempts += 1;
        if (attempts === 1) { const error = new Error('transient'); error.code = 'network-failed'; throw error; }
        return { results: [{ extensionId: 'demo.theme' }] };
      },
    }),
  });
  const result = await controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_SEARCH, query: 'demo', limit: 20 });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [250]);
});

test('search does not retry non-transient Marketplace failures', async () => {
  let attempts = 0;
  const controller = createThemeMarketplaceController({
    storageArea: storage(),
    wait: async () => { throw new Error('must not wait'); },
    client: clientStub({
      async search() { attempts += 1; const error = new Error('bad shape'); error.code = 'gallery-shape'; throw error; },
    }),
  });
  const result = await controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_SEARCH, query: 'demo', limit: 20 });
  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
});

test('install persists normalized Marketplace metadata and returns the installed record', async () => {
  const area = storage();
  const controller = createThemeMarketplaceController({
    storageArea: area,
    randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    now: () => new Date('2026-08-08T00:00:00.000Z'),
    client: clientStub({ async install() { return { extensionId:'demo.theme', displayName:'Demo', sourceVersion:'1.2.3', document, variantCount:2, derived:['accent'], adjusted:['line'] }; } }),
  });
  const result = await controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_INSTALL, extensionId: 'demo.theme' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.themeId, 'custom:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const record = area.state[CUSTOM_THEME_STORAGE_KEY].themes[0];
  assert.equal(record.source, 'vscode-marketplace');
  assert.equal(record.sourceId, 'demo.theme');
  assert.equal(record.sourceVersion, '1.2.3');
  assert.equal(JSON.stringify(record).includes('VSIX'), false);
});

test('duplicate source IDs return the existing record without network work', async () => {
  const existing = { id:'custom:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source:'vscode-marketplace',sourceId:'demo.theme',sourceVersion:'1',installedAt:'2026-08-08T00:00:00.000Z',document:normalizeThemeDocument(document) };
  const area = storage({ [CUSTOM_THEME_STORAGE_KEY]: { version: 1, themes: [existing] } });
  const controller = createThemeMarketplaceController({ storageArea: area, client: clientStub({ async install() { throw new Error('must not fetch'); } }) });
  const result = await controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_INSTALL, extensionId: 'demo.theme' });
  assert.equal(result.ok, true);
  assert.equal(result.data.themeId, existing.id);
  assert.equal(result.data.existing, true);
});

test('concurrent installs of the same source share one network and storage transaction', async () => {
  const area = storage();
  let installs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const controller = createThemeMarketplaceController({
    storageArea: area,
    randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    now: () => new Date('2026-08-08T00:00:00.000Z'),
    client: clientStub({
      async install() {
        installs += 1;
        await gate;
        return { extensionId:'demo.theme', displayName:'Demo', sourceVersion:'1.2.3', document, variantCount:2, derived:[], adjusted:[] };
      },
    }),
  });
  const first = controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_INSTALL, extensionId: 'demo.theme' });
  const second = controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_INSTALL, extensionId: 'demo.theme' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(installs, 1);
  assert.equal(a.ok, true);
  assert.deepEqual(b, a);
  assert.equal(area.state[CUSTOM_THEME_STORAGE_KEY].themes.length, 1);
});

test('concurrent installs of different sources serialize storage writes without losing a record', async () => {
  const area = storage();
  let uuid = 0;
  const controller = createThemeMarketplaceController({
    storageArea: area,
    randomUUID: () => `${String(++uuid).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    now: () => new Date('2026-08-08T00:00:00.000Z'),
    client: clientStub({
      async install(extensionId) {
        return { extensionId, displayName:extensionId, sourceVersion:'1.2.3', document, variantCount:2, derived:[], adjusted:[] };
      },
    }),
  });
  const [a, b] = await Promise.all([
    controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_INSTALL, extensionId: 'demo.one' }),
    controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_INSTALL, extensionId: 'demo.two' }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(area.state[CUSTOM_THEME_STORAGE_KEY].themes.map((item) => item.sourceId), ['demo.one', 'demo.two']);
});

test('controller returns stable safe errors without stacks or raw data', async () => {
  const controller = createThemeMarketplaceController({ storageArea: storage(), client: clientStub({ async search() { const error = new Error('raw secret body'); error.code='network-failed'; throw error; } }) });
  const result = await controller.handleMessage({ type: HERMES_THEME_MARKETPLACE_SEARCH, query: '', limit: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'network-failed');
  assert.doesNotMatch(JSON.stringify(result), /raw secret body|stack/);
});

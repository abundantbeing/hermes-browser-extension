import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { inspectSite, applySiteAdapterPolicy, isGmailThreadUrl } from '../extension/lib/site-adapters.mjs';
import { buildBrowserTurnEnvelope } from '../extension/lib/browser-context-protocol.mjs';
import { createPageContextAttachment, stageUserFiles } from '../extension/lib/user-file-attachments.mjs';
import {
  hydrateHermesBrowserSettingsFromStorage,
  packedHermesBrowserSettingsWrite,
  SAVED_CONNECTION_SECRETS_STORAGE_KEY,
} from '../extension/lib/saved-connections.mjs';

const root = new URL('../', import.meta.url);
function documentAt(html, url) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  Object.defineProperty(document, 'URL', { value: url });
  Object.defineProperty(document, 'baseURI', { value: url });
  return document;
}
function extractFunction(source, start, end) { return source.slice(source.indexOf(start), source.indexOf(end)); }
const gmailUrl = 'https://mail.google.com/mail/u/0/#inbox/ABCDEFGHIJKLMNOP';
const gmailHtml = '<h2 class="hP">Fixture thread</h2><div data-message-id="m1"><span class="gD">Sender</span><div class="a3s">FIRST_MESSAGE</div></div><div data-message-id="m2"><div class="a3s">LAST_MESSAGE<textarea>DRAFT_VALUE</textarea><div contenteditable="true">DRAFT_CONTENT</div></div></div>';

// Execute the real DOM-bound request builder, not a facsimile of the caller.
const panelSource = await readFile(new URL('extension/sidepanel.js', root), 'utf8');
const getPageContextSource = extractFunction(panelSource, 'async function getPageContext(tab,', 'async function getYoutubeTranscriptForTab(');
function panelHarness(stored = {}) {
  const calls = [];
  const context = vm.createContext({
    settings: { contextDepth: 'full', gmailCaptureEnabled: true, ...stored },
    isGmailThreadUrl,
    usesDashboardWsChatTransport: () => false,
    isLocalDocumentUrl: () => false,
    isRestrictedUrl: () => false,
    sendContentMessageWithInstallFallback: async (_id, message) => {
      calls.push(message.options);
      const adapter = inspectSite(documentAt(gmailHtml, gmailUrl), { url: gmailUrl, explicitCapture: message.options.explicitSiteCapture });
      return { ok: true, ...applySiteAdapterPolicy({ text: 'INBOX_NEVER_CAPTURED', meta: { headings: [{ text: 'Fixture thread' }] } }, adapter) };
    },
    getPageContextViaScripting: async () => { throw new Error('fallback not expected'); },
  });
  return { calls, context, read: vm.runInContext(`${getPageContextSource}; getPageContext`, context) };
}

test('stored Gmail approval survives repeated send-time reads and a fresh panel', async () => {
  for (const harness of [panelHarness(), panelHarness()]) {
    for (let i = 0; i < 2; i++) {
      const pc = await harness.read({ id: 7, url: gmailUrl });
      const turn = buildBrowserTurnEnvelope({ humanInput: 'Read the thread', activeTab: { id: 7, url: gmailUrl }, pageContext: pc, settings: { contextDepth: 'full', includePageText: true } });
      assert.match(turn.browser_context.payload.pageContext.text, /FIRST_MESSAGE/);
      assert.match(turn.browser_context.payload.pageContext.text, /LAST_MESSAGE/);
      assert.doesNotMatch(JSON.stringify(turn), /INBOX_NEVER_CAPTURED|DRAFT_VALUE|DRAFT_CONTENT/);
    }
  }
});

test('Gmail approval is off by default and never reads the mailbox list', async () => {
  const off = panelHarness({ gmailCaptureEnabled: false });
  assert.equal((await off.read({ id: 7, url: gmailUrl })).text, '');
  const on = panelHarness();
  await on.read({ id: 7, url: 'https://mail.google.com/mail/u/0/#inbox' });
  assert.equal(on.calls[0].explicitSiteCapture, false);
});

test('Gmail thread capture recognizes label, search, starred and all routes', () => {
  for (const hash of ['#label/Work/ABCDEFGHIJKLMNOP', '#search/from%3Aexample/ABCDEFGHIJKLMNOP', '#starred/ABCDEFGHIJKLMNOP', '#all/ABCDEFGHIJKLMNOP']) {
    const url = `https://mail.google.com/mail/u/0/${hash}`;
    const adapter = inspectSite(documentAt(gmailHtml, url), { url, explicitCapture: true });
    assert.equal(adapter.route.kind, 'thread', hash);
    assert.match(adapter.context.text, /LAST_MESSAGE/);
  }
});

test('Gmail category lists and paginated mailbox routes never become thread captures', () => {
  for (const hash of ['#category/primary', '#category/social', '#inbox/p2', '#search/Work/p2', '#label/Work/p3']) {
    const url = `https://mail.google.com/mail/u/0/${hash}`;
    assert.equal(isGmailThreadUrl(url), false, hash);
    const result = applySiteAdapterPolicy({ text: 'PRIVATE_LIST', meta: {} }, inspectSite(documentAt(gmailHtml, url), { url, explicitCapture: true }));
    assert.equal(result.text, '', hash);
  }
  assert.equal(isGmailThreadUrl('https://mail.google.com/mail/u/0/#category/primary/ABCDEFGHIJKLMNOP'), true);
});

test('Full context preserves an entire 25k article in the actual BCP v2 message', () => {
  const article = `BEGIN_ARTICLE ${'long published paragraph. '.repeat(1000)}END_ARTICLE`;
  const turn = buildBrowserTurnEnvelope({ humanInput: 'Summarize', activeTab: { id: 9, url: 'https://example.org/article' }, pageContext: { text: article, meta: {} }, settings: { contextDepth: 'full', includePageText: true } });
  assert.equal(turn.browser_context.payload.pageContext.text, article);
  assert.equal(turn.source_receipt.truncation.any, false);
});

test('Medium and Substack published reading views retain extracted article text', () => {
  for (const url of ['https://medium.com/@author/a-long-article-123456789abc', 'https://writer.substack.com/p/a-long-article']) {
    const document = documentAt('<main><article><h1>Published article</h1><p>PUBLIC_ARTICLE_BODY</p></article></main>', url);
    const adapter = inspectSite(document, { url });
    const result = applySiteAdapterPolicy({ text: 'PUBLIC_ARTICLE_BODY', meta: {} }, adapter);
    assert.equal(adapter.policy, 'automatic-read-only', url);
    assert.match(result.text, /PUBLIC_ARTICLE_BODY/);
  }
});

test('Medium editor and Substack inbox/feed stay private even with article-shaped DOM', () => {
  for (const url of ['https://medium.com/me/stories/drafts', 'https://medium.com/new-story', 'https://writer.substack.com/inbox', 'https://substack.com/home']) {
    const document = documentAt('<main><article><p>PRIVATE_ROUTE_BODY</p></article></main>', url);
    const result = applySiteAdapterPolicy({ text: 'PRIVATE_ROUTE_BODY', meta: {} }, inspectSite(document, { url }));
    assert.equal(result.text, '', url);
  }
});

test('Gmail approval persistence merges fresh storage without overwriting another surface', async () => {
  let stored = {
    hermesBrowserSettings: { model: 'new-model', unrelatedSetting: 42 },
    [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: {},
  };
  const context = vm.createContext({
    settings: { model: 'stale-model' }, els: {},
    async readBrowserSettingsFromStorage() {
      return hydrateHermesBrowserSettingsFromStorage(structuredClone(stored), null);
    },
    async setPackedBrowserSettings(next) {
      const packed = await packedHermesBrowserSettingsWrite(structuredClone(next), null);
      stored = { hermesBrowserSettings: packed.hermesBrowserSettings, [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY] };
    },
    async mergePackedBrowserSettingsFromStorage(mergeFn) {
      const fresh = await hydrateHermesBrowserSettingsFromStorage(structuredClone(stored), null);
      const next = typeof mergeFn === 'function' ? mergeFn(fresh) : { ...fresh, ...mergeFn };
      const packed = await packedHermesBrowserSettingsWrite(structuredClone(next), null);
      stored = { hermesBrowserSettings: packed.hermesBrowserSettings, [SAVED_CONNECTION_SECRETS_STORAGE_KEY]: packed[SAVED_CONNECTION_SECRETS_STORAGE_KEY] };
      return next;
    },
    browserApi: { storage: { local: {
      get: async () => structuredClone(stored),
      set: async () => {},
    } } },
  });
  const source = extractFunction(panelSource, 'async function persistGmailCaptureEnabled(', 'async function getPageContext(');
  const save = vm.runInContext(`${source}; persistGmailCaptureEnabled`, context);
  await save(true);
  assert.equal(stored.hermesBrowserSettings.gmailCaptureEnabled, true);
  assert.equal(stored.hermesBrowserSettings.model, 'new-model');
  assert.equal(stored.hermesBrowserSettings.unrelatedSetting, 42);
  await save(false);
  assert.equal(stored.hermesBrowserSettings.gmailCaptureEnabled, false);
});

test('subject-only Gmail capture is not falsely reported as a captured thread', () => {
  const document = documentAt('<h2 class="hP">Only the subject is loaded</h2>', gmailUrl);
  const result = applySiteAdapterPolicy({ text: 'INBOX_UI', meta: {} }, inspectSite(document, { url: gmailUrl, explicitCapture: true }));
  assert.equal(result.text, '');
  assert.equal(result.meta.siteAdapter.suppressed, true);
});

test('Gmail alternate message markup and nested identifiers are handled without duplicates', () => {
  const document = documentAt('<h2 class="hP">Fallback markup</h2><div class="adn"><div data-legacy-message-id="fallback"><span class="gD">Sender</span><div class="a3s">FALLBACK_BODY</div></div></div>', gmailUrl);
  const adapter = inspectSite(document, { url: gmailUrl, explicitCapture: true });
  assert.equal(adapter.context.itemCount, 1);
  assert.match(adapter.context.text, /FALLBACK_BODY/);
});

test('a 100k page is uploaded through file.attach and its exact tail is retrievable', async () => {
  const text = `FULL_PAGE_START ${'Public paragraph. '.repeat(6000)}FULL_PAGE_END`;
  const files = new Map();
  const store = { putFile: async (id, value) => files.set(id, value), getFile: async id => files.get(id) };
  const file = await createPageContextAttachment({ text, meta: {} }, { contextDepth: 'full', includePageText: true }, { store });
  assert.ok(file);
  const retained = await files.get(file.blobId).blob.text();
  assert.equal(retained, text);
  let uploaded;
  const client = { request: async (method, params) => {
    assert.equal(method, 'file.attach');
    assert.equal(params.session_id, 'fixture-session');
    uploaded = Buffer.from(params.data_url.split(',')[1], 'base64').toString('utf8');
    return { attached: true, path: 'D:/fixture/page-context.txt', ref_text: '@file:D:/fixture/page-context.txt' };
  } };
  await stageUserFiles(client, 'fixture-session', [file], { store, sourceKey: 'fixture-owner' });
  assert.equal(uploaded, text);
  const turn = buildBrowserTurnEnvelope({ humanInput: 'Summarize the whole page', activeTab: { id: 8, url: 'https://example.org/article' }, pageContext: { text, meta: {} }, settings: { contextDepth: 'full', includePageText: true }, attachments: [file] });
  assert.equal(turn.attachment_context.items[0].local_path, 'D:/fixture/page-context.txt');
  assert.equal(turn.browser_context.payload.pageContext.extraction.truncated, true);
  assert.match(turn.attachment_context.items[0].detail, /Complete captured page text/);
  assert.ok(JSON.stringify(turn).length <= 48_000);
});

test('disabled page sharing and private suppressed pages never create overflow files', async () => {
  const text = 'Private content. '.repeat(4000);
  for (const [pc, settings] of [[{ text, meta: {} }, { includePageText: false }], [{ text, restricted: true }, {}], [{ text, meta: { siteAdapter: { suppressed: true } } }, {}]]) {
    assert.equal(await createPageContextAttachment(pc, settings), null);
  }
});

test('serialization keeps a useful excerpt under escape-heavy total-budget pressure', () => {
  const turn = buildBrowserTurnEnvelope({ humanInput: 'Read code', activeTab: { id: 8, url: 'https://example.org/code' }, pageContext: { text: `CODE_START ${'"\\\\'.repeat(15000)} CODE_END`, meta: {} }, settings: { contextDepth: 'full', includePageText: true } });
  assert.match(turn.browser_context.payload.pageContext.text, /CODE_START/);
  assert.equal(turn.browser_context.payload.pageContext.extraction.truncated, true);
  assert.ok(JSON.stringify(turn).length <= 48_000);
});

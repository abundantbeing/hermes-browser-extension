import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { JSDOM } from 'jsdom';

import {
  ARTIFACT_FAMILIES,
  ARTIFACT_KINDS,
  artifactActionPlan,
  artifactExtension,
  artifactFailureNotice,
  artifactFileDownloadUrl,
  artifactFileFetchUrl,
  artifactFileName,
  artifactKindFamily,
  artifactKindForExtension,
  artifactMimeForExtension,
  describeArtifactFile,
  extractArtifactPaths,
} from '../extension/lib/artifact-actions.mjs';
import {
  ARTIFACT_CARD_PRIMARY_CLASS,
  DEFAULT_ARTIFACT_CARD_LIMIT,
  buildArtifactFileCard,
  formatArtifactBytes,
  hydrateArtifactCards,
  setArtifactCardBusy,
  setArtifactCardNote,
  splitArtifactFileName,
} from '../extension/lib/artifact-card.mjs';
import {
  probeArtifactFileSource,
  resolveArtifactDownloadSource,
  resolveArtifactFileSource,
} from '../extension/lib/media-source.mjs';

// The card markup reaches the DOM through renderMarkdownSafe, so this suite
// runs against a jsdom window the way tests/sanitizer.test.mjs does.
const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = window;
const { document } = window;
const { renderMarkdownSafe } = await import('../extension/lib/sanitizer.mjs');

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
const sidepanelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const parityCss = readFileSync(new URL('../extension/app-parity.css', import.meta.url), 'utf8');
const commonSource = readFileSync(new URL('../extension/lib/common.mjs', import.meta.url), 'utf8');

const BASE_URL = 'http://127.0.0.1:8765';
const PDF_PATH = 'C:\\Users\\Jaybo\\Documents\\quarterly-report.pdf';

function mount(html = '') {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

function buttons(card) {
  return [...card.querySelectorAll('button[data-artifact-action]')];
}

function actionIds(card) {
  return buttons(card).map((button) => button.dataset.artifactAction);
}

// ---------------------------------------------------------------------------
// 1. classifier matrix
// ---------------------------------------------------------------------------

const KIND_MATRIX = [
  ['C:\\Users\\Jaybo\\Documents\\quarterly-report.pdf', 'pdf', 'application/pdf', true],
  ['C:\\Users\\Jaybo\\Documents\\dashboard.html', 'html', 'text/html', true],
  ['C:\\Users\\Jaybo\\Documents\\plot.png', 'image', 'image/png', true],
  ['C:\\Users\\Jaybo\\Documents\\export.csv', 'csv', 'text/csv', true],
  ['C:\\Users\\Jaybo\\Documents\\payload.json', 'json', 'application/json', true],
  ['C:\\Users\\Jaybo\\Documents\\notes.md', 'markdown', 'text/markdown', true],
  ['C:\\Users\\Jaybo\\Documents\\clip.mp4', 'video', 'video/mp4', true],
  ['C:\\Users\\Jaybo\\Documents\\voice.mp3', 'audio', 'audio/mpeg', true],
  ['C:\\Users\\Jaybo\\Documents\\plain.txt', 'text', 'text/plain', true],
  ['C:\\Users\\Jaybo\\Documents\\backup.zip', 'archive', 'application/zip', false],
  ['C:\\Users\\Jaybo\\Documents\\book.xlsx', 'sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', false],
  ['C:\\Users\\Jaybo\\Documents\\brief.docx', 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', false],
  ['C:\\Users\\Jaybo\\Documents\\deck.pptx', 'presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', false],
  ['C:\\Users\\Jaybo\\Documents\\mystery.qqq', 'binary', 'application/octet-stream', false],
];

test('every returned-file kind maps to its viewability, MIME type, and action list', () => {
  for (const [filePath, kind, mime, viewable] of KIND_MATRIX) {
    const descriptor = describeArtifactFile(filePath);
    assert.equal(descriptor.kind, kind, filePath);
    assert.equal(descriptor.mime, mime, filePath);
    assert.equal(descriptor.viewable, viewable, filePath);
    assert.equal(descriptor.local, true, filePath);
    assert.ok(descriptor.badge.length > 0, `a badge should exist for ${kind}`);

    const plan = artifactActionPlan(filePath);
    const ids = plan.actions.map((action) => action.id);
    assert.deepEqual(
      ids,
      viewable ? ['open', 'open-on-computer', 'save'] : ['open-on-computer', 'save'],
      `${kind} actions`,
    );
    if (!viewable) {
      assert.equal(ids.includes('open'), false, `${kind} must not offer a browser preview`);
    }
    for (const action of plan.actions) {
      assert.equal(action.enabled, true, `${kind}/${action.id} should be enabled before a read is attempted`);
    }
  }
});

test('every kind lands in one of the five card families, and the family is carried on the plan', () => {
  const expected = {
    pdf: 'document',
    html: 'document',
    text: 'document',
    markdown: 'document',
    json: 'document',
    document: 'document',
    presentation: 'document',
    sheet: 'sheet',
    csv: 'sheet',
    image: 'media',
    video: 'media',
    audio: 'media',
    archive: 'archive',
    binary: 'unknown',
  };
  // A kind is not an extension: sample each kind with a real extension so the
  // descriptor path is exercised too.
  const sampleExtension = {
    pdf: 'pdf',
    html: 'html',
    text: 'txt',
    markdown: 'md',
    json: 'json',
    document: 'docx',
    presentation: 'pptx',
    sheet: 'xlsx',
    csv: 'csv',
    image: 'png',
    video: 'mp4',
    audio: 'mp3',
    archive: 'zip',
    binary: 'qqq',
  };
  for (const [kind, family] of Object.entries(expected)) {
    assert.equal(artifactKindFamily(kind), family, `${kind} -> ${family}`);
    const extension = sampleExtension[kind];
    assert.ok(extension, `${kind} needs a sample extension in this test`);
    const descriptor = describeArtifactFile(`C:\\a\\x.${extension}`);
    assert.equal(descriptor.kind, kind, `x.${extension} should classify as ${kind}`);
    assert.equal(descriptor.family, family, `the descriptor should carry ${family}`);
  }
  assert.deepEqual(Object.keys(expected).sort(), [...ARTIFACT_KINDS].sort(), 'every artifact kind must be mapped to a family');
  assert.equal(artifactKindFamily('not-a-kind'), 'unknown', 'an unmapped kind falls back to the unknown family');
  assert.equal(artifactKindFamily(''), 'unknown');
  assert.equal(artifactActionPlan(PDF_PATH).family, 'document', 'the action plan carries the family for the surface to tint by');

  // Every family must be reachable from a real extension, or a tint is dead.
  const reachable = new Set(ARTIFACT_KINDS.map((kind) => artifactKindFamily(kind)));
  for (const family of ARTIFACT_FAMILIES) {
    assert.equal(reachable.has(family), true, `no kind maps to the ${family} family`);
  }
});

test('extension helpers stay total for odd input and never invent a kind', () => {
  assert.equal(artifactKindForExtension('.PDF'), 'pdf');
  assert.equal(artifactKindForExtension('PPTM'), 'binary');
  assert.equal(artifactMimeForExtension('.zip'), 'application/zip');
  assert.equal(artifactMimeForExtension(''), 'application/octet-stream');
  assert.equal(artifactExtension('C:\\a\\b.PNG'), 'png');
  assert.equal(artifactExtension('C:\\a\\b'), '');
  assert.equal(artifactFileName(''), '');
  assert.equal(describeArtifactFile(null).kind, 'binary');
  assert.equal(describeArtifactFile(undefined).name, 'Generated file');
  assert.equal(describeArtifactFile({}).viewable, false);
  assert.equal(describeArtifactFile('C:\\Users\\Jaybo\\Documents\\').name, 'Documents');
});

test('a file the dashboard cannot read disables every action and says why', () => {
  const plan = artifactActionPlan(PDF_PATH, { readable: false, reason: 'http-403' });
  assert.equal(plan.readable, false);
  assert.equal(plan.actions.every((action) => action.enabled === false), true);
  assert.equal(plan.actions.every((action) => action.reason === plan.notice), true);
  assert.match(plan.notice, /HTTP 403/);

  const unknown = artifactActionPlan(PDF_PATH, { readable: false, reason: 'teapot-mode' });
  assert.match(unknown.notice, /teapot-mode/, 'an unknown reason stays visible instead of being flattened');
  assert.match(artifactFailureNotice('http-404'), /HTTP 404/);
  assert.match(artifactFailureNotice(''), /could not read this file/);
});

// ---------------------------------------------------------------------------
// 2. file-name extraction
// ---------------------------------------------------------------------------

test('file names come out of Windows and POSIX paths, spaces and backslashes intact', () => {
  assert.equal(artifactFileName('C:\\Users\\Jaybo\\My Documents\\quarterly report.pdf'), 'quarterly report.pdf');
  assert.equal(artifactExtension('C:\\Users\\Jaybo\\My Documents\\quarterly report.pdf'), 'pdf');
  assert.equal(artifactFileName('/home/jaybo/my docs/quarterly report.pdf'), 'quarterly report.pdf');
  assert.equal(artifactFileName('~/exports/2026 revenue.csv'), '2026 revenue.csv');
  assert.equal(artifactFileName('\\\\server\\share\\deck final.pptx'), 'deck final.pptx');
  assert.equal(artifactFileName('D:/Hermes/.hermes/notes.md'), 'notes.md');
  assert.equal(artifactFileName('https://cdn.example.com/reports/q2.pdf?token=abc#page=2'), 'q2.pdf');
  assert.equal(artifactFileName('MEDIA: "C:\\My Documents\\report v2.pdf"'), 'report v2.pdf');
  assert.equal(artifactFileName('media: C:\\Users\\Jaybo\\Documents\\sheet.xlsx'), 'sheet.xlsx');
  assert.equal(artifactFileName('C:\\Users\\Jaybo\\Documents\\a%20b.pdf'), 'a b.pdf');

  const windows = describeArtifactFile('C:\\Users\\Jaybo\\My Documents\\q2 report.pdf');
  assert.equal(windows.local, true);
  assert.equal(windows.viewable, true);
  assert.equal(describeArtifactFile('notes.md').local, false, 'a bare relative name is not a local artifact');
  assert.equal(describeArtifactFile('https://cdn.example.com/a.pdf').local, false);
  assert.equal(describeArtifactFile('https://cdn.example.com/a.pdf').kind, 'pdf');
});

test('plain-text paths are found, de-duplicated, capped, and never mistaken for URLs', () => {
  const text = [
    'Saved the report to C:\\Users\\Jaybo\\My Documents\\quarterly report.pdf today.',
    'Also wrote C:\\Users\\Jaybo\\Documents\\book.xlsx and `/home/jaybo/a b/notes.md`',
    'Two more: C:\\a\\x.csv and C:\\b\\y.json were produced.',
    'Open https://example.com/thing.pdf for reference',
    'see ./relative/notes.md and rel.txt',
    'Log at C:\\temp\\run.log; nothing else.',
    'No artifacts here, just words.',
  ].join('\n');
  const found = extractArtifactPaths(text, { limit: 10 });
  assert.deepEqual(found.map((entry) => entry.source), [
    'C:\\Users\\Jaybo\\My Documents\\quarterly report.pdf',
    'C:\\Users\\Jaybo\\Documents\\book.xlsx',
    '/home/jaybo/a b/notes.md',
    'C:\\a\\x.csv',
    'C:\\b\\y.json',
    'C:\\temp\\run.log',
  ]);
  assert.equal(found.every((entry) => entry.local), true);

  assert.deepEqual(extractArtifactPaths(text, { limit: 2 }).map((entry) => entry.name), [
    'quarterly report.pdf',
    'book.xlsx',
  ]);
  assert.deepEqual(extractArtifactPaths('C:\\a\\b.pdf C:\\a\\b.pdf', { limit: 5 }).length, 1);
  assert.deepEqual(extractArtifactPaths('', { limit: 5 }), []);
  assert.deepEqual(extractArtifactPaths('A folder C:\\Users\\Jaybo\\Documents\\ holds files.', { limit: 5 }), []);
});

// ---------------------------------------------------------------------------
// 3. bytes through the authenticated dashboard transport
// ---------------------------------------------------------------------------

test('the fallback download URL is the only place the session token travels in a URL', () => {
  assert.equal(
    artifactFileDownloadUrl({ baseUrl: `${BASE_URL}/`, filePath: 'C:\\a b\\x.pdf', token: 'tok 1' }),
    `${BASE_URL}/api/files/download?path=C%3A%5Ca+b%5Cx.pdf&token=tok+1`,
  );
  assert.equal(artifactFileDownloadUrl({ baseUrl: '', filePath: 'C:\\a.pdf' }), '');
  assert.equal(artifactFileDownloadUrl({ baseUrl: BASE_URL, filePath: '' }), '');
  // The extension's own read of the bytes never carries the token in the URL:
  // the same route authenticates on the X-Hermes-Session-Token header.
  assert.equal(
    artifactFileFetchUrl({ baseUrl: `${BASE_URL}/`, filePath: 'C:\\a b\\x.pdf' }),
    `${BASE_URL}/api/files/download?path=C%3A%5Ca+b%5Cx.pdf`,
  );
  assert.equal(artifactFileFetchUrl({ baseUrl: '', filePath: 'C:\\a.pdf' }), '');
});

test('resolveArtifactFileSource fetches the file with the session header and returns a blob URL', async () => {
  const calls = [];
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'application/pdf' });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, blob: async () => blob };
  };
  const result = await resolveArtifactFileSource(PDF_PATH, {
    baseUrl: BASE_URL,
    token: 'session-token',
    fetchImpl,
    createObjectUrl: (received) => {
      assert.equal(received, blob);
      return 'blob:http://127.0.0.1:8765/fake-object-1';
    },
  });

  assert.deepEqual(result, {
    ok: true,
    url: 'blob:http://127.0.0.1:8765/fake-object-1',
    transport: 'dashboard-file-download',
    size: 4,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE_URL}/api/files/download?path=${encodeURIComponent(PDF_PATH)}`);
  assert.doesNotMatch(calls[0].url, /token/, 'the token must not be copied into the request URL');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers['X-Hermes-Session-Token'], 'session-token');
  assert.equal(calls[0].options.credentials, 'include');
});

test('resolveArtifactFileSource fails honestly instead of handing back a dead URL', async () => {
  const forStatus = async (status) => resolveArtifactFileSource(PDF_PATH, {
    baseUrl: BASE_URL,
    fetchImpl: async () => ({ ok: false, status }),
  });
  assert.deepEqual(await forStatus(403), { ok: false, reason: 'http-403' });
  assert.deepEqual(await forStatus(404), { ok: false, reason: 'http-404' });

  assert.deepEqual(
    await resolveArtifactFileSource('C:\\a\\x.pdf', { fetchImpl: async () => ({ ok: true, status: 200 }) }),
    { ok: false, reason: 'missing-base-url' },
  );
  assert.deepEqual(
    await resolveArtifactFileSource('   ', { baseUrl: BASE_URL, fetchImpl: async () => ({ ok: true }) }),
    { ok: false, reason: 'missing-file-path' },
  );
  assert.deepEqual(
    await resolveArtifactFileSource(PDF_PATH, {
      baseUrl: BASE_URL,
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
    }),
    { ok: false, reason: 'aborted' },
  );
  assert.deepEqual(
    await resolveArtifactFileSource(PDF_PATH, {
      baseUrl: BASE_URL,
      fetchImpl: async () => ({ ok: true, status: 200, blob: async () => new Blob([]) }),
    }),
    { ok: false, reason: 'empty-file' },
  );
  assert.deepEqual(
    await resolveArtifactFileSource(PDF_PATH, {
      baseUrl: BASE_URL,
      fetchImpl: async () => ({ ok: true, status: 200, blob: async () => ({ size: 4 }) }),
      createObjectUrl: () => 'nonsense',
    }),
    { ok: false, reason: 'object-url-unavailable' },
  );
});

test('the readability probe HEADs the same URL and falls back to a ranged GET', async () => {
  const seen = [];
  const headOk = await probeArtifactFileSource(PDF_PATH, {
    baseUrl: BASE_URL,
    token: 'tok',
    fetchImpl: async (url, options) => {
      seen.push({ url, method: options.method, range: options.headers.Range, token: options.headers['X-Hermes-Session-Token'] });
      return { ok: true, status: 200, headers: { get: (name) => (name === 'content-length' ? '4096' : null) } };
    },
  });
  assert.deepEqual(headOk, { ok: true, size: 4096 });
  assert.equal(seen[0].method, 'HEAD');
  assert.equal(seen[0].url, `${BASE_URL}/api/files/download?path=${encodeURIComponent(PDF_PATH)}`);
  assert.doesNotMatch(seen[0].url, /token/, 'the probe URL must not carry the session token either');
  assert.equal(seen[0].token, 'tok', 'the probe authenticates with the session header');

  const ranged = [];
  const fallback = await probeArtifactFileSource(PDF_PATH, {
    baseUrl: BASE_URL,
    fetchImpl: async (url, options) => {
      ranged.push({ method: options.method, range: options.headers.Range });
      if (options.method === 'HEAD') return { ok: false, status: 405 };
      return { ok: true, status: 206, headers: { get: () => null }, body: { cancel: async () => {} } };
    },
  });
  assert.deepEqual(fallback, { ok: true, size: null });
  assert.deepEqual(ranged, [
    { method: 'HEAD', range: undefined },
    { method: 'GET', range: 'bytes=0-0' },
  ]);

  assert.deepEqual(
    await probeArtifactFileSource(PDF_PATH, {
      baseUrl: BASE_URL,
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    { ok: false, reason: 'http-403' },
  );
});

// ---------------------------------------------------------------------------
// 4. the card itself
// ---------------------------------------------------------------------------

test('a viewable file gets a leading type token, a de-emphasised extension, the meta line, and its actions', () => {
  const plan = artifactActionPlan(PDF_PATH, { readable: true });
  const card = buildArtifactFileCard(document, plan, { size: 4096 });
  assert.equal(card.className, 'artifact-card');
  assert.equal(card.dataset.artifactPath, PDF_PATH);
  assert.equal(card.dataset.artifactKind, 'pdf');
  assert.equal(card.dataset.artifactFamily, 'document');
  assert.equal(card.dataset.artifactState, 'ready');
  assert.equal(card.querySelector('.artifact-card-kind').textContent, 'PDF');
  // The name reads as one string, but the extension is its own element so the
  // surface can de-emphasise it by size and weight.
  const name = card.querySelector('.artifact-card-name');
  assert.equal(name.textContent, 'quarterly-report.pdf');
  assert.equal(name.title, PDF_PATH, 'the whole path stays available on hover');
  assert.equal(name.querySelector('.artifact-card-name-ext').textContent, '.pdf');
  assert.equal(name.firstChild.textContent, 'quarterly-report');
  // One mono meta line: where it lives and how big it is. The path itself is
  // not printed — it is one hover away, on both the name and the meta line.
  const meta = card.querySelector('.artifact-card-source');
  assert.equal(meta.textContent, 'On this computer · 4 KB');
  assert.equal(meta.title, PDF_PATH);
  assert.equal(card.getAttribute('title'), null, 'the card root carries no title of its own');
  assert.equal(card.dataset.artifactReveal, 'enter', 'a freshly built card is marked for the short reveal');
  assert.deepEqual(actionIds(card), ['open', 'open-on-computer', 'save']);
  assert.equal(buttons(card).every((button) => button.disabled === false), true);
  assert.equal(card.querySelector('.artifact-card-note'), null, 'a readable card has no note');

  // The first action of the plan is the primary tile, the rest are outlined.
  const primary = card.querySelector(`.${ARTIFACT_CARD_PRIMARY_CLASS}`);
  assert.equal(primary.dataset.artifactAction, 'open');
  assert.equal(buttons(card).filter((button) => button.classList.contains(ARTIFACT_CARD_PRIMARY_CLASS)).length, 1);
  assert.equal(card.querySelector(`[data-artifact-action="save"]`).classList.contains(ARTIFACT_CARD_PRIMARY_CLASS), false);

  const clicked = [];
  const wired = buildArtifactFileCard(document, plan, {
    handlers: { open: (receivedPlan, receivedCard) => clicked.push([receivedPlan.source, receivedCard === wired]) },
  });
  buttons(wired)[0].click();
  assert.deepEqual(clicked, [[PDF_PATH, true]]);
});

test('a kind the browser cannot preview leads with Open on computer instead of Open', () => {
  const card = buildArtifactFileCard(document, artifactActionPlan('C:\\a\\book.xlsx', { readable: true }), { size: 2048 });
  assert.equal(card.dataset.artifactFamily, 'sheet');
  const primary = card.querySelector(`.${ARTIFACT_CARD_PRIMARY_CLASS}`);
  assert.equal(primary.dataset.artifactAction, 'open-on-computer');
  assert.equal(primary.textContent, 'Open on computer');
  assert.equal(card.querySelector(`[data-artifact-action="open"]`), null);
  assert.equal(card.querySelector('.artifact-card-source').textContent, 'On this computer · 2 KB');
  assert.equal(card.querySelector('.artifact-card-name-ext').textContent, '.xlsx');
});

test('file names split into a base and an extension without losing a character', () => {
  assert.deepEqual(splitArtifactFileName('quarterly-report.pdf', 'pdf'), { base: 'quarterly-report', extension: '.pdf' });
  assert.deepEqual(splitArtifactFileName('ARCHIVE.ZIP', 'zip'), { base: 'ARCHIVE', extension: '.ZIP' });
  assert.deepEqual(splitArtifactFileName('notes', ''), { base: 'notes', extension: '' });
  assert.deepEqual(splitArtifactFileName('odd.name.pdf', 'pdf'), { base: 'odd.name', extension: '.pdf' });
  const plan = artifactActionPlan('C:\\a\\book.xlsx', { readable: true });
  const card = buildArtifactFileCard(document, plan);
  assert.equal(card.querySelector('.artifact-card-name').textContent, plan.name, 'splitting never changes what the name reads as');
});

test('a file the browser cannot preview offers no Open button at all', () => {
  const spreadsheet = buildArtifactFileCard(document, artifactActionPlan('C:\\a\\book.xlsx', { readable: true }));
  assert.deepEqual(actionIds(spreadsheet), ['open-on-computer', 'save']);
  assert.equal(spreadsheet.querySelector('[data-artifact-action="open"]'), null);

  const archive = buildArtifactFileCard(document, artifactActionPlan('C:\\a\\bundle.zip', { readable: true }));
  assert.deepEqual(actionIds(archive), ['open-on-computer', 'save']);
});

test('an unreadable card is disabled, dashed, and explains itself', () => {
  const card = buildArtifactFileCard(document, artifactActionPlan('C:\\a\\book.xlsx', { readable: false, reason: 'http-404' }));
  assert.equal(card.dataset.artifactState, 'unreadable');
  assert.equal(buttons(card).length, 2);
  for (const button of buttons(card)) {
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.match(button.title, /HTTP 404/);
  }
  assert.match(card.querySelector('.artifact-card-note').textContent, /HTTP 404/);
});

test('labels and sizes stay honest and localizable', () => {
  const card = buildArtifactFileCard(document, artifactActionPlan(PDF_PATH, { readable: true }), {
    labels: { open: 'Ouvrir', save: 'Enregistrer sous' },
    size: 1_500_000,
  });
  assert.deepEqual(buttons(card).map((button) => button.textContent), ['Ouvrir', 'Open on computer', 'Enregistrer sous']);
  assert.match(card.querySelector('.artifact-card-source').textContent, /1\.4 MB/);

  assert.equal(formatArtifactBytes(0), '0 B');
  assert.equal(formatArtifactBytes(999), '999 B');
  assert.equal(formatArtifactBytes(1024), '1 KB');
  assert.equal(formatArtifactBytes(undefined), '');
});

test('busy and note helpers never leave a dead or double-firing control', () => {
  const card = buildArtifactFileCard(document, artifactActionPlan(PDF_PATH, { readable: true }));
  setArtifactCardBusy(card, true);
  assert.equal(card.dataset.artifactBusy, 'true');
  assert.equal(buttons(card).every((button) => button.disabled === true), true);
  setArtifactCardBusy(card, false);
  assert.equal(buttons(card).every((button) => button.disabled === false), true);

  const blocked = buildArtifactFileCard(document, artifactActionPlan('C:\\a\\b.zip', { readable: false, reason: 'http-403' }));
  setArtifactCardBusy(blocked, true);
  setArtifactCardBusy(blocked, false);
  assert.equal(buttons(blocked).every((button) => button.disabled === true), true, 'a blocked button must stay blocked');

  assert.equal(setArtifactCardNote(card, 'Opening…').textContent, 'Opening…');
  assert.equal(setArtifactCardNote(card, ''), null);
  assert.equal(card.querySelector('.artifact-card-note'), null);
});

// ---------------------------------------------------------------------------
// 5. hydration wiring (the chip becomes the card)
// ---------------------------------------------------------------------------

test('the markdown chip carries the path and no buttons until the file is proven readable', () => {
  const html = renderMarkdownSafe(`MEDIA: ${PDF_PATH}`);
  assert.match(html, /artifact-card-pending/);
  assert.match(html, /data-artifact-path="C:\\Users\\Jaybo\\Documents\\quarterly-report\.pdf"/);
  assert.match(html, /artifact-card-kind" aria-hidden="true">PDF</);
  assert.match(html, /quarterly-report\.pdf/);
  assert.doesNotMatch(html, /<button/, 'the un-hydrated chip must not offer a button that cannot work');
  assert.doesNotMatch(html, /generated-image-unavailable/, 'a returned file is not an unavailable image');
});

test('hydration upgrades the chip into the live card with the seeded plan', async () => {
  const root = mount(renderMarkdownSafe(`MEDIA: ${PDF_PATH}`));
  const plan = artifactActionPlan(PDF_PATH, { readable: true });
  const placed = await hydrateArtifactCards(root, {
    buildPlan: async () => ({ plan, size: 2048 }),
    labels: { open: 'Open' },
  });

  assert.equal(placed, 1);
  assert.equal(root.querySelectorAll('.artifact-card-pending').length, 0);
  const card = root.querySelector('.artifact-card');
  assert.equal(card.dataset.artifactState, 'ready');
  assert.deepEqual(actionIds(card), ['open', 'open-on-computer', 'save']);
  assert.equal(card.getAttribute('title'), null);
  assert.match(card.textContent, /quarterly-report\.pdf/);
  assert.match(card.textContent, /2 KB/);

  // Idempotent: a second pass over the same DOM adds nothing.
  assert.equal(await hydrateArtifactCards(root, { buildPlan: async () => ({ plan }) }), 0);
  assert.equal(root.querySelectorAll('.artifact-card').length, 1);
});

test('hydration fails honestly when the file cannot be resolved', async () => {
  const root = mount(renderMarkdownSafe(`MEDIA: C:\\a\\book.xlsx`));
  const unreadable = artifactActionPlan('C:\\a\\book.xlsx', { readable: false, reason: 'http-403' });
  await hydrateArtifactCards(root, { buildPlan: async () => ({ plan: unreadable }) });

  const card = root.querySelector('.artifact-card');
  assert.equal(card.dataset.artifactState, 'unreadable');
  assert.deepEqual(actionIds(card), ['open-on-computer', 'save']);
  assert.equal(buttons(card).every((button) => button.disabled === true), true);
  assert.match(card.querySelector('.artifact-card-note').textContent, /HTTP 403/);

  // A plan that cannot even be built leaves the honest button-less chip alone.
  const unresolved = mount(renderMarkdownSafe(`MEDIA: ${PDF_PATH}`));
  await hydrateArtifactCards(unresolved, { buildPlan: async () => null });
  assert.equal(unresolved.querySelector('.artifact-card-pending') !== null, true);
  assert.equal(unresolved.querySelectorAll('button').length, 0);
});

test('a card stranded before the dashboard answered heals itself once the file is readable', async () => {
  const root = mount(renderMarkdownSafe(`MEDIA: ${PDF_PATH}`));
  const blocked = artifactActionPlan(PDF_PATH, { readable: false, reason: 'missing-base-url' });
  await hydrateArtifactCards(root, { buildPlan: async () => ({ plan: blocked }) });
  assert.equal(root.querySelector('.artifact-card').dataset.artifactState, 'unreadable');

  const readable = artifactActionPlan(PDF_PATH, { readable: true });
  await hydrateArtifactCards(root, { buildPlan: async () => ({ plan: readable, size: 8 }) });
  const healed = root.querySelector('.artifact-card');
  assert.equal(healed.dataset.artifactState, 'ready');
  assert.deepEqual(actionIds(healed), ['open', 'open-on-computer', 'save']);
  assert.equal(buttons(healed).every((button) => button.disabled === false), true);
  assert.equal(root.querySelectorAll('.artifact-card').length, 1);
});

test('a path written as plain text grows a card after its block, not inside it', async () => {
  const root = mount('<p>Saved the report to C:\\Users\\Jaybo\\My Documents\\quarterly report.pdf today.</p>'
    + '<ul><li>Also wrote C:\\Users\\Jaybo\\Documents\\book.xlsx</li></ul>');
  const placed = await hydrateArtifactCards(root, {
    buildPlan: async (filePath) => ({ plan: artifactActionPlan(filePath, { readable: true }) }),
  });

  assert.equal(placed, 2);
  const paragraphCard = root.querySelector('p + .artifact-card');
  assert.ok(paragraphCard, 'the paragraph keeps its card as a sibling');
  assert.equal(paragraphCard.dataset.artifactPath, 'C:\\Users\\Jaybo\\My Documents\\quarterly report.pdf');
  assert.equal(paragraphCard.dataset.artifactState, 'ready');

  const listCard = root.querySelector('ul + .artifact-card');
  assert.ok(listCard, 'a list item carries its card after the list');
  assert.equal(listCard.dataset.artifactPath, 'C:\\Users\\Jaybo\\Documents\\book.xlsx');
  assert.equal(root.querySelectorAll('li .artifact-card').length, 0, 'no card is nested inside the list markup');

  // Idempotent across re-renders that keep the block.
  assert.equal(await hydrateArtifactCards(root, {
    buildPlan: async (filePath) => ({ plan: artifactActionPlan(filePath, { readable: true }) }),
  }), 0);
  assert.equal(root.querySelectorAll('.artifact-card').length, 2);
});

test('hydration also works on a message body rendered before it is appended', async () => {
  // The panel builds a message body, renders its content, and only then appends
  // it to the transcript — a detached subtree must hydrate all the same.
  const detached = document.createElement('div');
  detached.innerHTML = renderMarkdownSafe(`MEDIA: ${PDF_PATH}`);
  const placed = await hydrateArtifactCards(detached, {
    buildPlan: async (filePath) => ({ plan: artifactActionPlan(filePath, { readable: true }) }),
  });
  assert.equal(placed, 1);
  assert.deepEqual(actionIds(detached.querySelector('.artifact-card')), ['open', 'open-on-computer', 'save']);
});

test('hydration never floods a message: the per-root card budget is respected', async () => {
  const paths = Array.from({ length: 9 }, (_, index) => `C:\\out\\file-${index}.pdf`);
  const root = mount(`<p>Files: ${paths.join(' ')}</p>`);
  await hydrateArtifactCards(root, {
    buildPlan: async (filePath) => ({ plan: artifactActionPlan(filePath, { readable: true }) }),
  });
  assert.equal(root.querySelectorAll('.artifact-card').length, DEFAULT_ARTIFACT_CARD_LIMIT);
});

test('hydration ignores code blocks and content it has already processed', async () => {
  const root = mount('<pre><code>C:\\out\\tool-dump.pdf</code></pre><p>Nothing here.</p>');
  const placed = await hydrateArtifactCards(root, {
    buildPlan: async (filePath) => ({ plan: artifactActionPlan(filePath, { readable: true }) }),
  });
  assert.equal(placed, 0);
  assert.equal(root.querySelectorAll('.artifact-card').length, 0);
});

// ---------------------------------------------------------------------------
// 6. surface wiring
// ---------------------------------------------------------------------------

test('the side panel hydrates returned-file cards and keeps the honest chip fallback', () => {
  assert.match(sidepanelSource, /import \{ hydrateArtifactCards, setArtifactCardBusy, setArtifactCardNote \} from '\.\/lib\/artifact-card\.mjs';/);
  const sourceImport = sidepanelSource.match(/import\s*\{([\s\S]*?)\}\s*from '\.\/lib\/media-source\.mjs';/);
  assert.ok(sourceImport, 'the side panel should import from the media-source module');
  for (const name of ['mediaDisplayName', 'mediaSourcePlan', 'probeArtifactFileSource', 'resolveArtifactFileSource']) {
    assert.ok(sourceImport[1].includes(name), `the media-source import should bring in ${name}`);
  }
  assert.match(sidepanelSource, /async function hydrateArtifactFileCards\(root, \{ scanText = true \} = \{\}\)/);
  assert.match(sidepanelSource, /if \(!element\?\.closest\?\.\('\.message\.user'\)\) void hydrateArtifactFileCards\(element\);/);
  assert.match(sidepanelSource, /await hydrateArtifactFileCards\(els\.messages\);/);
  // The three actions, on the one authenticated transport the panel already uses.
  assert.match(sidepanelSource, /await probeArtifactFileSource\(filePath, \{ baseUrl, token \}\)/);
  assert.match(sidepanelSource, /await resolveArtifactFileSource\(plan\.source, \{ baseUrl, token \}\)/);
  assert.match(sidepanelSource, /browserApi\.downloads\.download\(\{ url, filename: plan\.name \}\)/);
  assert.match(sidepanelSource, /await browserApi\.downloads\.open\(Number\(downloadId\)\);/);
  assert.match(sidepanelSource, /saveAs: true/);
  // The old honest chip is still what an unreadable media path gets.
  assert.match(sidepanelSource, /stays an honest filename chip/);
  assert.match(sidepanelSource, /node\.classList\.add\('unavailable'\)/);
});

test('the full tab renders the same chip and hydrates it with the same three actions', () => {
  assert.match(appSource, /import \{ hydrateArtifactCards, setArtifactCardBusy, setArtifactCardNote \} from '\.\/lib\/artifact-card\.mjs';/);
  assert.match(appSource, /function renderArtifactCard\(artifact\)/);
  assert.match(appSource, /filename: artifact\.name/);
  assert.match(appSource, /function hydrateArtifactFileCards\(root, \{ scanText = true \} = \{\}\)/);
  assert.match(appSource, /await hydrateArtifactFileCards\(els\.messageList\);/);
  assert.match(appSource, /await resolveArtifactFileSource\(plan\.source, \{ baseUrl, token \}\)/);
  assert.match(appSource, /browserApi\.downloads\.download\(\{ url, filename: plan\.name, saveAs: true \}\)/);
  // A local artifact is not rendered twice (chip + standalone card).
  assert.match(appSource, /if \(artifact\.kind !== 'remote'\) continue;/);
});

test('the markdown renderer emits the chip for returned files and leaves media alone', () => {
  assert.match(commonSource, /import \{ artifactFileChipMarkup \} from '\.\/artifact-card\.mjs';/);
  assert.match(commonSource, /return artifactFileChipMarkup\(filePath\);/);
  assert.match(commonSource, /if \(inline\) return '';/);
  const image = renderMarkdownSafe('MEDIA: C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_1.png');
  assert.match(image, /data-session-media="image"/);
  assert.match(image, /data-media-path=/);
  assert.doesNotMatch(image, /artifact-card/);
  const video = renderMarkdownSafe('MEDIA: C:\\Users\\Jaybo\\clips\\clip.mp4');
  assert.match(video, /data-session-media="video"/);
});

test('both surfaces style the card, its disabled state, and its unreadable boundary', () => {
  for (const css of [sidepanelCss, parityCss]) {
    assert.match(css, /\.artifact-card\s*\{/);
    assert.match(css, /\.artifact-card-head\s*\{/);
    assert.match(css, /\.artifact-card-kind\s*\{/);
    assert.match(css, /\.artifact-card-actions\s*\{/);
    assert.match(css, /\.artifact-card-actions button:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
    assert.match(css, /\.artifact-card\[data-artifact-state="unreadable"\]\s*\{\s*border-style:\s*dashed;/);
  }
  // The hover the card buttons inherit keeps a boundary and never hardcodes white.
  const sidepanelHover = sidepanelCss.match(/button:hover,\r?\nbutton:focus-visible[^}]*\}/)?.[0] || '';
  assert.match(sidepanelHover, /background: var\(--hermes-primary-bg, var\(--hermes-ink\)\)/);
  assert.doesNotMatch(sidepanelHover, /255,\s*255,\s*255|#fff/i);
});
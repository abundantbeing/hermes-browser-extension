import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHTML } from 'linkedom';

import {
  CONTENT_EXTRACTION_API,
  EXTRACTION_SCHEMA,
  EXTRACTION_VERSION,
  collectPageContext,
  extractPageContent,
  redactSensitiveTextWithCount,
} from '../extension/lib/content-extraction-core.mjs';

function documentFor(html, url = 'https://example.com/article?utm_source=test#comments') {
  const { document } = parseHTML(html);
  Object.defineProperty(document, 'URL', { configurable: true, value: url });
  Object.defineProperty(document, 'location', { configurable: true, value: new URL(url) });
  return document;
}

test('extractor exports a stable versioned data-only API', () => {
  assert.equal(EXTRACTION_SCHEMA, 'hermes.browser.extraction.v1');
  assert.match(EXTRACTION_VERSION, /^1\.\d+\.\d+$/);
  assert.equal(CONTENT_EXTRACTION_API.schema, EXTRACTION_SCHEMA);
  assert.equal(CONTENT_EXTRACTION_API.version, EXTRACTION_VERSION);
  assert.equal(typeof CONTENT_EXTRACTION_API.extractPageContent, 'function');
  assert.equal(typeof CONTENT_EXTRACTION_API.collectPageContext, 'function');
  assert.equal('html' in CONTENT_EXTRACTION_API, false);
});

test('candidate scoring prefers article content over navigation and sidebar boilerplate', () => {
  const document = documentFor(`<!doctype html>
    <html lang="en"><head>
      <title>Hermes Browser Architecture</title>
      <meta name="description" content="A detailed extractor design.">
      <link rel="canonical" href="https://example.com/article?secret=hidden#fragment">
    </head><body>
      <nav>Home Pricing Docs Login Account Settings</nav>
      <aside>Related links Subscribe Cookie settings Advertisement</aside>
      <main>
        <article class="post article-content">
          <h1>Hermes Browser Architecture</h1>
          <p>Hermes Browser needs a reliable main-content extractor. It should preserve useful prose while removing navigation and unrelated interface chrome.</p>
          <p>The implementation scores semantic candidates, paragraph density, and sentence structure. Link-heavy sidebars receive a penalty.</p>
          <h2>Safety boundary</h2>
          <p>Page content is untrusted data. Extraction never converts page markup into trusted instructions and never captures form values.</p>
          <pre><code>const safe = true;</code></pre>
        </article>
      </main>
      <footer>Privacy Terms Careers Contact</footer>
    </body></html>`);

  const result = extractPageContent(document, { maxTextChars: 12_000, debug: true });

  assert.equal(result.schema, EXTRACTION_SCHEMA);
  assert.equal(result.version, EXTRACTION_VERSION);
  assert.equal(result.method, 'candidate-reader');
  assert.ok(result.confidence >= 0.6);
  assert.match(result.content.text, /reliable main-content extractor/i);
  assert.match(result.content.text, /const safe = true/);
  assert.doesNotMatch(result.content.text, /Cookie settings Advertisement/);
  assert.doesNotMatch(result.content.text, /Privacy Terms Careers/);
  assert.equal(result.metadata.canonicalUrl, 'https://example.com/article');
  assert.equal(result.metadata.language, 'en');
  assert.ok(result.debug.candidates.length > 0);
  assert.equal(result.debug.candidates[0].tag, 'article');
  assert.equal(document.querySelector('nav')?.textContent, 'Home Pricing Docs Login Account Settings');
  assert.equal(document.querySelector('footer')?.textContent, 'Privacy Terms Careers Contact');
});

test('metadata precedence favors JSON-LD article values and returns bounded semantic structure', () => {
  const document = documentFor(`<!doctype html><html lang="fr"><head>
    <title>Fallback title</title>
    <meta property="og:title" content="OpenGraph title">
    <meta property="og:site_name" content="Example Gazette">
    <meta name="author" content="Meta Author">
    <meta property="article:published_time" content="2026-07-16T12:00:00Z">
    <script type="application/ld+json">{
      "@context":"https://schema.org",
      "@type":"Article",
      "headline":"Structured headline",
      "author":{"@type":"Person","name":"Structured Author"},
      "datePublished":"2026-07-15",
      "publisher":{"@type":"Organization","name":"Structured Publisher"}
    }</script>
  </head><body><article>
    <h1>Visible headline</h1>
    <h2>Section one</h2>
    <p>This paragraph contains enough readable sentence content to establish the article candidate and make the structure useful.</p>
    <blockquote>Important quoted detail.</blockquote>
    <ul><li>First point</li><li>Second point</li></ul>
    <table><caption>Results</caption><tr><th>Name</th><th>Score</th></tr><tr><td>Hermes</td><td>10</td></tr></table>
    <a href="https://example.com/source?token=secret#private">Source reference</a>
    <img src="https://example.com/diagram.png?signature=secret" alt="Architecture diagram" width="800" height="450">
  </article></body></html>`);

  const result = extractPageContent(document);

  assert.equal(result.metadata.title, 'Structured headline');
  assert.equal(result.metadata.author, 'Structured Author');
  assert.equal(result.metadata.publishedAt, '2026-07-15');
  assert.equal(result.metadata.siteName, 'Structured Publisher');
  assert.equal(result.metadata.language, 'fr');
  assert.deepEqual(result.structure.headings.map(({ level, text }) => [level, text]), [
    ['h1', 'Visible headline'],
    ['h2', 'Section one'],
  ]);
  assert.equal(result.structure.blockquotes[0].text, 'Important quoted detail.');
  assert.equal(result.structure.lists[0].items.length, 2);
  assert.equal(result.structure.tables[0].rows[1][0], 'Hermes');
  assert.equal(result.structure.links[0].url, 'https://example.com/source');
  assert.equal(result.structure.images[0].url, 'https://example.com/diagram.png');
  assert.equal(result.structure.images[0].alt, 'Architecture diagram');
  assert.equal('html' in result, false);
});

test('privacy pipeline redacts secrets and captures form metadata without values', () => {
  const document = documentFor(`<!doctype html><html><body><main>
    <h1>Account support article</h1>
    <p>Use api_key=sk_live_abcdefghijklmnop when testing. Authorization: Bearer verysecretvalue123.</p>
    <form aria-label="Sign in">
      <label>Email <input type="email" name="email" value="person@example.com"></label>
      <label>Password <input type="password" name="password" value="do-not-capture"></label>
      <label>Code <input autocomplete="one-time-code" name="otp" value="123456"></label>
      <button type="submit">Continue</button>
    </form>
    <p>This second readable paragraph provides enough prose for the extractor to choose the main element safely.</p>
  </main></body></html>`);

  const result = extractPageContent(document);

  assert.match(result.content.text, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(JSON.stringify(result), /do-not-capture|person@example\.com|123456/);
  assert.ok(result.privacy.redactionCount >= 2);
  assert.equal(result.privacy.formValuesCaptured, false);
  assert.equal(result.privacy.sensitiveFieldsPresent, true);
  assert.deepEqual(result.structure.forms[0].fields.map((field) => field.type), ['email', 'password', 'text']);
  assert.equal(result.structure.forms[0].fields[2].sensitive, true);
  assert.equal(document.querySelector('input[type="password"]')?.getAttribute('value'), 'do-not-capture');
});

test('unsafe and credential-bearing URLs are removed from extraction output', () => {
  const credentialedDocument = documentFor(`<!doctype html><html><head>
    <link rel="canonical" href="https://user:password@example.com/private?token=secret">
  </head><body><main>
    <h1>Public article</h1>
    <p>This readable public paragraph exists only to establish a normal extraction candidate with enough sentence content.</p>
    <a href="javascript:alert(1)">Unsafe action</a>
    <a href="https://user:password@example.com/private">Credentialed link</a>
  </main></body></html>`, 'https://user:password@example.com/private?token=secret');

  const result = extractPageContent(credentialedDocument);

  assert.equal(result.sourceUrl, '');
  assert.equal(result.metadata.canonicalUrl, '');
  assert.deepEqual(result.structure.links.map((link) => link.url), ['', '']);
  assert.doesNotMatch(JSON.stringify(result), /user:password|token=secret|javascript:/);
});

test('weak pages use the explicit raw-body fallback and clamp output', () => {
  const document = documentFor('<!doctype html><html><body><div>Short but useful status text</div></body></html>');
  const result = extractPageContent(document, { maxTextChars: 18 });

  assert.equal(result.method, 'raw-body-fallback');
  assert.equal(result.confidence, 0.2);
  assert.equal(result.content.truncated, true);
  assert.match(result.content.text, /\[truncated\]$/);
});

test('redactSensitiveTextWithCount returns deterministic text and replacement count', () => {
  const result = redactSensitiveTextWithCount('token=synthetic-token-value password: synthetic-password-value normal words');
  assert.equal(result.text, 'token=[REDACTED_SECRET] password: [REDACTED_SECRET] normal words');
  assert.equal(result.count, 2);
});

test('CSS-hidden content is removed before candidate scoring and structure extraction', () => {
  const hiddenMarker = 'PRIVATE_DRAFT_SHOULD_NOT_LEAVE_PAGE';
  const document = documentFor(`<!doctype html><html><body>
    <article style="display:none"><h1>Hidden draft</h1><p>${hiddenMarker} ${'hidden prose. '.repeat(80)}</p></article>
    <article>
      <h1>Visible public article</h1>
      <p>${'Visible public prose. '.repeat(24)}</p>
      <section class="stylesheet-hidden"><h2>Hidden stylesheet section</h2><p>${hiddenMarker}_STYLESHEET</p></section>
      <section class="visibility-hidden"><p>${hiddenMarker}_VISIBILITY</p></section>
      <section class="opacity-hidden"><p>${hiddenMarker}_OPACITY</p></section>
    </article>
  </body></html>`);
  Object.defineProperty(document.defaultView, 'getComputedStyle', {
    configurable: true,
    value(node) {
      return {
        display: node?.classList?.contains('stylesheet-hidden') ? 'none' : 'block',
        visibility: node?.classList?.contains('visibility-hidden') ? 'hidden' : 'visible',
        opacity: node?.classList?.contains('opacity-hidden') ? '0' : '1',
        contentVisibility: 'visible',
      };
    },
  });

  const result = extractPageContent(document);

  assert.equal(result.method, 'candidate-reader');
  assert.match(result.content.text, /Visible public article/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(hiddenMarker));
});

test('encoded secret assignments are redacted without decoding ordinary display text', () => {
  const result = redactSensitiveTextWithCount([
    'api%5Fkey=encoded-private-value',
    'client%255Fsecret=double-encoded-private-value',
    'api%5Fkey%=malformed-escape-private-value',
    'password=raw-private-value',
    'ordinary%20display%20text',
  ].join(' '));

  assert.equal(result.count, 4);
  assert.doesNotMatch(result.text, /encoded-private-value|double-encoded-private-value|malformed-escape-private-value|raw-private-value/);
  assert.match(result.text, /api%5Fkey=\[REDACTED_SECRET\]/);
  assert.match(result.text, /client%255Fsecret=\[REDACTED_SECRET\]/);
  assert.match(result.text, /api%5Fkey%=\[REDACTED_SECRET\]/);
  assert.match(result.text, /ordinary%20display%20text/);
});

test('sensitive form metadata is classified without serializing raw names or autocomplete values', () => {
  const document = documentFor(`<!doctype html><html><body><main>
    <h1>Public support article</h1>
    <p>${'Visible public prose. '.repeat(24)}</p>
    <form aria-label="Credential support">
      <input name="api%5Fkey=form-private-value" autocomplete="client%5Fsecret=metadata-private-value">
    </form>
  </main></body></html>`);

  const result = extractPageContent(document);
  const field = result.structure.forms[0].fields[0];

  assert.equal(field.sensitive, true);
  assert.equal(field.name, '');
  assert.equal(field.autocomplete, '');
  assert.doesNotMatch(JSON.stringify(result), /form-private-value|metadata-private-value/);
});

test('oversized JSON-LD input is skipped before parsing', () => {
  const oversizedHeadline = 'x'.repeat(70_000);
  const document = documentFor(`<!doctype html><html><head>
    <title>Visible fallback title</title>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Article', headline: oversizedHeadline })}</script>
  </head><body><article><h1>Visible article</h1><p>${'Visible public prose. '.repeat(24)}</p></article></body></html>`);

  const result = extractPageContent(document);

  assert.equal(result.metadata.title, 'Visible fallback title');
  assert.equal(result.limits.jsonLdScriptsSkipped, 1);
});

test('aggregate extraction and bridge payloads stay within serialized budgets', () => {
  const cell = 'x'.repeat(240);
  const tables = Array.from({ length: 12 }, (_, tableIndex) => `<table><caption>T${tableIndex}</caption>${Array.from({ length: 30 }, () => `<tr>${Array.from({ length: 12 }, () => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`).join('');
  const document = documentFor(`<!doctype html><html><body><article>
    <h1>Large public report</h1>
    <p>${'Readable report sentence. '.repeat(600)}</p>
    ${tables}
  </article></body></html>`);

  const extraction = extractPageContent(document, { maxTextChars: 12_000, maxEnvelopeChars: 24_000 });
  const context = collectPageContext(document, {
    maxTextChars: 12_000,
    maxEnvelopeChars: 24_000,
    maxContextChars: 32_000,
  });
  const tightContext = collectPageContext(document, {
    maxTextChars: 4_000,
    maxSelectedTextChars: 4_000,
    maxEnvelopeChars: 8_000,
    maxContextChars: 8_000,
    selectedText: 'selected '.repeat(1_000),
  });

  assert.ok(JSON.stringify(extraction).length <= 24_000);
  assert.ok(extraction.limits.serializedChars <= 24_000);
  assert.equal(extraction.limits.maxEnvelopeChars, 24_000);
  assert.equal(extraction.limits.structureTruncated, true);
  assert.ok(JSON.stringify(context).length <= 32_000);
  assert.equal(context.extraction.detailsIncluded, false);
  assert.equal('structure' in context.extraction, false);
  assert.equal('text' in context.extraction.content, false);
  assert.ok(JSON.stringify(tightContext).length <= 8_000);
  assert.ok(tightContext.extraction.limits.serializedContextChars <= 8_000);
});

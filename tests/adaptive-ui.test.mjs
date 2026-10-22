import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// DOMPurify needs a real DOM; node --test runs each file in its own process.
const { window } = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = window;

const {
  HAUI_BLOCK_TYPES,
  dispatchAdaptiveAction,
  markdownToPlainText,
  parseAdaptiveFence,
  presentMarkdownParts,
  readAdaptiveAction,
  renderAdaptiveMarkdown,
  safeAdaptiveUrl,
  splitAdaptiveSegments,
  stripAdaptiveFences,
  validateAdaptiveEnvelope,
} = await import('../extension/lib/adaptive-ui.mjs');
const { renderMarkdownSafe, renderResponseSafe } = await import('../extension/lib/sanitizer.mjs');

const fence = (value) => `\`\`\`hermes-ui\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\``;
const envelope = (blocks) => ({ schema: 'hermes.adaptive-ui', version: 1, blocks });
const dom = (html) => {
  const host = window.document.createElement('div');
  host.innerHTML = html;
  return host;
};

const STATS = envelope([
  { id: 'rev', type: 'stat', label: 'Revenue', value: '$1.2M', delta: '+12%', trend: 'up' },
  { id: 'users', type: 'stat', label: 'Users', value: 48000 },
]);
const CHART = { id: 'sales', type: 'chart', kind: 'bar', title: 'Sales', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: '2025', values: [10, 20, 15] }] };

test('the block allowlist is exactly the HAUI v1 set', () => {
  assert.deepEqual([...HAUI_BLOCK_TYPES], ['stat', 'comparison', 'key_value', 'table', 'chart', 'disclosure', 'actions']);
});

test('schema validation accepts v1 envelopes and rejects everything else', () => {
  assert.equal(validateAdaptiveEnvelope(STATS).ok, true);
  assert.equal(validateAdaptiveEnvelope({ version: 1, blocks: STATS.blocks }).ok, true, 'schema may be omitted');
  assert.equal(validateAdaptiveEnvelope({ ...STATS, schema: 'other' }).ok, false);
  assert.equal(validateAdaptiveEnvelope({ ...STATS, version: 2 }).ok, false);
  assert.equal(validateAdaptiveEnvelope({ ...STATS, version: '1' }).ok, false);
  assert.equal(validateAdaptiveEnvelope([]).ok, false);
  assert.equal(validateAdaptiveEnvelope(envelope([])).ok, false);
  const unknown = validateAdaptiveEnvelope(envelope([{ id: 'x', type: 'map', fallback: 'Three cafés nearby.' }, { id: 'y', type: 'iframe' }]));
  assert.equal(unknown.ok, true, 'unknown types with fallback text still render');
  assert.deepEqual(unknown.blocks.map((block) => block.type), ['markdown']);
  assert.match(unknown.errors.join(' '), /unknown block type 'iframe'/);
});

test('ids are stable, deduplicated and safe', () => {
  const result = validateAdaptiveEnvelope(envelope([
    { id: 'a', type: 'stat', label: 'A', value: 1 },
    { id: 'a', type: 'stat', label: 'B', value: 2 },
    { id: '"><img>', type: 'stat', label: 'C', value: 3 },
  ]));
  assert.deepEqual(result.blocks.map((block) => block.id), ['a', 'a-1', 'b2']);
});

test('bad chart data falls back instead of drawing invented numbers', () => {
  const cases = [
    { ...CHART, kind: 'pie' },
    { ...CHART, series: [{ name: 'x', values: [1, 2] }] },
    { ...CHART, series: [{ name: 'x', values: [1, 'two', 3] }] },
    { ...CHART, series: [{ name: 'x', values: [null, null, null] }] },
    { ...CHART, labels: Array.from({ length: 30 }, (_, index) => `L${index}`), series: [{ values: Array(30).fill(1) }] },
  ];
  for (const chart of cases) {
    const result = parseAdaptiveFence('hermes-ui', JSON.stringify(envelope([chart])));
    assert.equal(result.ok, false, JSON.stringify(chart).slice(0, 60));
  }
  const html = renderResponseSafe(`Intro\n\n${fence(envelope([{ ...CHART, kind: 'pie' }]))}`, { style: 'vivid' });
  assert.doesNotMatch(html, /<svg/);
  assert.match(html, /<pre><code data-lang="hermes-ui">/, 'malformed blocks stay readable as their source');
});

test('valid blocks render native, accessible components', () => {
  const blocks = envelope([
    ...STATS.blocks,
    CHART,
    { id: 'cmp', type: 'comparison', title: 'Plans', items: [{ title: 'Basic', points: ['256 GB'] }, { title: 'Pro', points: ['512 GB'], highlight: true }] },
    { id: 'kv', type: 'key_value', items: [{ key: 'Owner', value: 'Ana' }] },
    { id: 'tbl', type: 'table', columns: ['Name', 'Score'], rows: [['A', 3], ['B', 4]] },
    { id: 'more', type: 'disclosure', title: 'Method', body: 'We used **two** sources.' },
  ]);
  const host = dom(renderResponseSafe(`Summary first.\n\n${fence(blocks)}\n\nAfter.`, { style: 'vivid' }));
  assert.equal(host.querySelectorAll('.haui-stat').length, 2);
  assert.equal(host.querySelectorAll('.haui-stat-grid').length, 1, 'neighbouring stats share one grid');
  assert.equal(host.querySelector('.haui-stat[data-trend="up"] .haui-stat-delta').textContent, '▲ +12%');
  const chart = host.querySelector('[data-haui-type="chart"]');
  assert.equal(chart.querySelector('svg[role="img"]').getAttribute('viewBox'), '0 0 320 172', 'native SVG chart with a fixed box');
  assert.equal(chart.querySelectorAll('rect').length, 3);
  assert.equal(chart.querySelector('.haui-chart-table').hidden, true, 'the data table is there for the table view');
  assert.equal(host.querySelectorAll('.haui-compare-card').length, 2);
  const cardTitle = host.querySelector('.haui-compare-card[data-highlight="true"] .haui-card-title');
  assert.equal(cardTitle.textContent, 'Pro');
  assert.equal(cardTitle.tagName, 'DIV', 'not an <h4>, so chat and font-profile heading styles never shrink it');
  assert.equal(cardTitle.getAttribute('role'), 'heading');
  assert.equal(host.querySelector('.haui-kv dt').textContent, 'Owner');
  assert.equal(host.querySelector('.haui-table .haui-data-table td.haui-num').textContent, '3');
  assert.equal(host.querySelector('details.haui-disclosure summary').textContent, 'Method');
  assert.ok(host.querySelector('details.haui-disclosure strong'));
  assert.match(host.textContent, /Summary first\.[\s\S]*After\./, 'prose before and after stays');
});

test('script, HTML and handler injection is neutralized', () => {
  const hostile = envelope([
    { id: 'x', type: 'stat', label: '<img src=x onerror=alert(1)>', value: '<script>alert(1)</script>' },
    { id: 'y', type: 'actions', items: [
      { label: 'Copy', action: 'copy', value: '"><svg onload=alert(1)>' },
      { label: 'Bad', action: 'open_url', value: 'javascript:alert(1)' },
      { label: 'Data', action: 'open_url', value: 'data:text/html,<script>alert(1)</script>' },
      { label: 'Creds', action: 'open_url', value: 'https://user:pass@example.com/' },
      { label: 'Run', action: 'eval', value: 'alert(1)' },
      { label: 'Click', action: 'browser_click', value: '#buy' },
      { label: 'Good', action: 'open_url', value: 'https://example.com/docs' },
    ] },
    { id: 'z', type: 'table', columns: ['<b>c</b>'], rows: [['<iframe src=//evil>']] },
  ]);
  const html = renderResponseSafe(fence(hostile), { style: 'vivid' });
  const host = dom(html);
  assert.equal(host.querySelector('script, iframe, img, [onerror], [onload]'), null);
  assert.doesNotMatch(html, /javascript:|data:text/);
  const links = [...host.querySelectorAll('a.haui-action')];
  assert.deepEqual(links.map((link) => link.getAttribute('href')), ['https://example.com/docs']);
  assert.equal(links[0].getAttribute('rel'), 'noopener noreferrer');
  const buttons = [...host.querySelectorAll('button.haui-action')].map((button) => button.dataset.hauiAction);
  assert.deepEqual(buttons, ['copy'], 'unsupported actions never render');
  assert.equal(host.querySelector('button.haui-action').dataset.hauiValue, '"><svg onload=alert(1)>');
  assert.equal(host.querySelector('button.haui-action .haui-action-preview').textContent, '"><svg onload=alert(1)>', 'copied text is shown, not hidden behind a label');
  assert.equal(links[0].querySelector('.haui-action-preview').textContent, 'example.com ↗', 'a link shows where it goes');
  assert.equal(safeAdaptiveUrl('https://example.com'), 'https://example.com/');
  assert.equal(safeAdaptiveUrl('chrome://settings'), '');
});

test('size and nesting limits hold', () => {
  const huge = JSON.stringify(envelope([{ id: 'k', type: 'key_value', items: [{ key: 'a', value: 'x'.repeat(40000) }] }]));
  assert.equal(parseAdaptiveFence('hermes-ui', huge).ok, false);
  const deep = parseAdaptiveFence('hermes-ui', JSON.stringify(envelope([
    { id: 'd1', type: 'disclosure', title: 'One', body: 'a', blocks: [{ id: 'd2', type: 'disclosure', title: 'Two', body: 'b', blocks: [{ id: 'd3', type: 'stat', label: 'x', value: 1 }] }] },
  ])));
  assert.equal(deep.ok, true);
  assert.equal(deep.blocks[0].blocks[0].blocks.length, 0, 'nothing deeper than two levels');
  const many = parseAdaptiveFence('hermes-ui', JSON.stringify(envelope(Array.from({ length: 40 }, (_, index) => ({ id: `s${index}`, type: 'stat', label: 'L', value: index })))));
  assert.equal(many.blocks.length, 16);
});

test('streaming: an open block never shows JSON, finished parts keep their identity', () => {
  const body = JSON.stringify(STATS);
  const partial = `Numbers below.\n\n\`\`\`hermes-ui\n${body.slice(0, 40)}`;
  const streaming = renderResponseSafe(partial, { style: 'vivid' });
  assert.doesNotMatch(streaming, /schema|hermes\.adaptive-ui/);
  assert.match(streaming, /class="haui-pending"/);
  const done = renderResponseSafe(`${partial}${body.slice(40)}\n\`\`\`\n\nMore text`, { style: 'vivid' });
  const later = renderResponseSafe(`${partial}${body.slice(40)}\n\`\`\`\n\nMore text that keeps streaming`, { style: 'vivid' });
  const pendingId = dom(streaming).querySelector('.haui-pending').dataset.hauiId;
  const grid = (html) => dom(html).querySelector('.haui-stat-grid');
  assert.equal(pendingId, `${grid(done).dataset.hauiId.split(':')[0]}:pending`, 'the placeholder and the block share the fence id');
  assert.equal(grid(done).outerHTML, grid(later).outerHTML, 'a finished block is identical while later text streams');
  const segments = splitAdaptiveSegments(`${partial}${body.slice(40)}\n\`\`\``);
  assert.deepEqual(segments.map((segment) => [segment.kind, segment.complete ?? true]), [['markdown', true], ['ui', true]]);
});

test('restore is deterministic and never duplicates blocks', () => {
  const text = `A\n\n${fence(STATS)}\n\nB\n\n${fence(envelope([CHART]))}`;
  const first = renderResponseSafe(text, { style: 'vivid' });
  assert.equal(first, renderResponseSafe(text, { style: 'vivid' }));
  assert.equal(dom(first).querySelectorAll('[data-haui-type="chart"]').length, 1);
  assert.equal(dom(first).querySelectorAll('.haui-stat').length, 2);
});

test('plain Markdown fallback: rich text is unchanged and simple replies stay simple', () => {
  const corpus = ['Hello there!', '**Bold** and a [link](https://example.com).', '| A | B |\n|---|---|\n| x | 1 |', '```js\nconst a = 1;\n```', '![Generated image](https://cdn.example.com/a.png)'];
  for (const text of corpus) {
    assert.equal(renderResponseSafe(text, { style: 'rich' }), renderMarkdownSafe(text));
  }
  assert.equal(renderResponseSafe('Hello there!', { style: 'vivid' }), renderMarkdownSafe('Hello there!'));
  assert.equal(renderResponseSafe('```js\nconst a = 1;\n```', { style: 'vivid' }), renderMarkdownSafe('```js\nconst a = 1;\n```'));
  assert.match(renderResponseSafe('![Generated image](https://cdn.example.com/a.png)', { style: 'vivid' }), /<img/);
});

test('the presentation layer only reshapes unambiguous, finished structures', () => {
  const metrics = '- **Revenue:** $1.2M (up 12%)\n- **Users:** 48K\n- **Churn:** 2.1%';
  const finished = presentMarkdownParts(`Results:\n\n${metrics}\n\nThat is all.`);
  assert.deepEqual(finished.map((part) => part.kind), ['markdown', 'blocks', 'markdown']);
  assert.deepEqual(finished[1].blocks.map((block) => [block.label, block.value, block.caption]), [['Revenue', '$1.2M', 'up 12%'], ['Users', '48K', ''], ['Churn', '2.1%', '']]);
  assert.deepEqual(presentMarkdownParts(`Results:\n\n${metrics}`).map((part) => part.kind), ['markdown'], 'a list still streaming is left alone');
  assert.equal(presentMarkdownParts('- **Note:** remember to check the oven\n- **Tip:** use foil\n\nok').length, 1, 'prose values are not metrics');

  const table = '| Month | Sales | Cost |\n|---|---|---|\n| Jan | 10 | 4 |\n| Feb | 12 | 5 |\n| Mar | 9 | 6 |';
  const html = renderResponseSafe(`Here:\n\n${table}\n\nNotes follow.`, { style: 'vivid' });
  const host = dom(html);
  assert.ok(host.querySelector('.md-table-wrap table'), 'the written table stays');
  const derived = host.querySelector('details.haui-derived');
  assert.equal(derived.querySelector('summary').textContent, 'View as chart');
  assert.equal(derived.open, false, 'the chart waits behind a click');
  assert.equal(derived.querySelectorAll('polyline').length, 2, 'month labels draw a line per numeric column');
  const words = '| Name | Role |\n|---|---|\n| Ana | Dev |\n| Bo | PM |\n| Cy | QA |';
  assert.doesNotMatch(renderResponseSafe(`${words}\n\nok`, { style: 'vivid' }), /haui-derived/);
  assert.doesNotMatch(renderResponseSafe(`Here:\n\n${table}`, { style: 'vivid' }), /haui-derived/, 'a table at the streaming tail is not charted');
});

test('Hermes Mobile vivid fences map onto HAUI blocks', () => {
  const lines = [
    { version: 'v0.9', createSurface: { surfaceId: 'c1', catalogId: 'hermes://vivid/catalog/v1' } },
    { version: 'v0.9', updateComponents: { surfaceId: 'c1', components: [
      { id: 'root', component: 'Stack', children: ['s', 'pick', 'tool'] },
      { id: 's', component: 'Stat', label: 'Speed', value: '42 ms' },
      { id: 'pick', component: 'Choices', options: ['Fastest', 'Scenic'], action: { event: { name: 'choose' } } },
      { id: 'tool', component: 'Tool', html: '<script>alert(1)</script>' },
    ] } },
  ].map((line) => JSON.stringify(line)).join('\n');
  const html = renderResponseSafe(`Pick one.\n\n\`\`\`vivid\n${lines}\n\`\`\``, { style: 'vivid' });
  const host = dom(html);
  assert.equal(host.querySelector('.haui-stat-value').textContent, '42 ms');
  assert.deepEqual([...host.querySelectorAll('button[data-haui-action="ask"]')].map((button) => button.textContent), ['Fastest', 'Scenic']);
  assert.equal(host.querySelector('script'), null, 'the Tool component is never run');
});

test('copy and search see prose, and plain text drops Markdown formatting', () => {
  assert.equal(stripAdaptiveFences(`Top.\n\n${fence(STATS)}\n\nBottom.`), 'Top.\n\nBottom.');
  assert.equal(markdownToPlainText('# Title\n**bold** and `code` [docs](https://a.b)\n- one'), 'Title\nbold and code docs (https://a.b)\n• one');
  const plain = renderResponseSafe(`## Plan\n\n1. **First** step\n2. Second\n\n${fence(STATS)}\n\n\`\`\`sh\nnpm test\n\`\`\``, { style: 'plain' });
  const host = dom(plain);
  assert.equal(host.querySelector('h2, strong, ol, ul, .haui-block'), null);
  assert.match(host.textContent, /Plan[\s\S]*1\. First step/);
  assert.equal(host.querySelector('pre.plain-response-code').textContent, 'npm test');
  assert.ok(dom(renderResponseSafe('![Generated image](https://cdn.example.com/a.png)', { style: 'plain' })).querySelector('img'), 'generated images still show');
});

test('the typed dispatcher allows view, copy and ask only, and never sends', async () => {
  const host = dom(renderResponseSafe(fence(envelope([CHART, { id: 'act', type: 'actions', items: [
    { label: 'Copy summary', action: 'copy', value: 'Revenue up 12%' },
    { label: 'Ask more', action: 'ask', value: 'Break it down by region' },
  ] }])), { style: 'vivid' }));
  const figure = host.querySelector('[data-haui-type="chart"]');
  await dispatchAdaptiveAction(readAdaptiveAction(figure.querySelector('[data-haui-value="table"]')));
  assert.equal(figure.dataset.hauiView, 'table');
  assert.equal(figure.querySelector('.haui-chart-canvas').hidden, true);
  assert.equal(figure.querySelector('.haui-chart-table').hidden, false);
  assert.equal(figure.querySelector('[data-haui-value="table"]').getAttribute('aria-pressed'), 'true');

  const copied = [];
  const asked = [];
  const timers = [];
  const handlers = { copyText: async (text) => copied.push(text), askHermes: (text) => asked.push(text), setTimer: (fn) => timers.push(fn) };
  const copyButton = host.querySelector('[data-haui-action="copy"]');
  await dispatchAdaptiveAction(readAdaptiveAction(copyButton), handlers);
  assert.deepEqual(copied, ['Revenue up 12%']);
  assert.equal(copyButton.querySelector('.haui-action-label').textContent, 'Copied');
  timers.forEach((fn) => fn());
  assert.equal(copyButton.querySelector('.haui-action-label').textContent, 'Copy summary');
  assert.equal(copyButton.querySelector('.haui-action-preview').textContent, 'Revenue up 12%', 'the button shows exactly what it copies');
  await dispatchAdaptiveAction(readAdaptiveAction(host.querySelector('[data-haui-action="ask"]')), handlers);
  assert.deepEqual(asked, ['Break it down by region']);

  const forged = window.document.createElement('button');
  forged.setAttribute('data-haui-action', 'browser_click');
  assert.equal(readAdaptiveAction(forged), null);
});

test('side panel and full tab share the renderer, actions and the style guide', () => {
  const panel = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const tab = fs.readFileSync(new URL('../extension/app.js', import.meta.url), 'utf8');
  for (const js of [panel, tab]) {
    assert.match(js, /renderResponseSafe\(/);
    assert.match(js, /const action = readAdaptiveAction\(event\.target\);[\s\S]{0,80}dispatchAdaptiveAction\(action, \{/);
  }
  assert.match(panel, /responseStyleInstructions\(settings\.responseStyle\)/);
  assert.match(panel, /function patchRenderedMessageContent[\s\S]*?dataset\.hauiSig/);
});

test('card titles stay readable in every font profile', () => {
  const css = fs.readFileSync(new URL('../extension/lib/adaptive-ui.css', import.meta.url), 'utf8');
  const rule = css.match(/\.haui-compare-card \.haui-card-title \{[^}]*\}/)?.[0] || '';
  assert.match(rule, /font-family: var\(--hermes-font-ui/);
  assert.match(rule, /font-size: 1\.12em/);
  assert.match(rule, /line-height: 1\.25/);
  assert.match(css, /\.haui-stat-value \{[^}]*calc\(2em \* var\(--hermes-display-scale, 1\)\)/, 'stat numbers get the narrow-face scale');
  assert.doesNotMatch(renderResponseSafe(fence(envelope([{ id: 'c', type: 'comparison', items: [{ title: 'A' }, { title: 'B' }] }])), { style: 'vivid' }), /<h[1-6]/);
});

test('vivid fences with repeated or looping child ids stay bounded', () => {
  const fan = Array.from({ length: 10 }, () => 'n');
  const components = [
    { id: 'root', component: 'Stack', children: ['loop', 'cmp', ...fan] },
    { id: 'loop', component: 'Stack', children: ['loop', 'root'] },
    { id: 'n', component: 'Stack', children: fan },
    { id: 'cmp', component: 'Compare', items: [{ title: 'A', children: ['t', 't', 'self'] }, { title: 'B', children: ['self'] }] },
    { id: 't', component: 'Text', text: 'fast' },
    { id: 'self', component: 'Card', children: ['self', 'self', 't'] },
  ];
  const body = JSON.stringify({ version: 'v0.9', updateComponents: { surfaceId: 's', components } });
  const started = performance.now();
  const result = parseAdaptiveFence('vivid', body);
  assert.ok(performance.now() - started < 200, 'no exponential walk');
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocks.map((block) => block.type), ['comparison']);
});

test('only Hermes replies take the response style in the side panel', () => {
  const panel = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(panel, /const style = element\?\.closest\?\.\('\.message\.assistant'\) \? responsePresentationFromSettings\(settings\)\.responseStyle : 'rich';/);
});

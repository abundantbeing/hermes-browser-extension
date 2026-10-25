import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');

test('Sidecar is panel-lifecycle scoped and new session keeps it dismissed', async () => {
  const source = await read('extension/sidepanel.js');
  assert.match(source, /let browserIntroDismissedForPanel\s*=\s*false/);
  const visibility = source.match(/function renderBrowserIntroVisibility\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(visibility, /browserIntroDismissedForPanel\s*\|\|\s*messages\.length\s*>\s*0/);
  assert.doesNotMatch(visibility, /browserIntroSeen/);
  assert.match(source, /async function persistBrowserIntroSeen\(\)\s*\{[\s\S]{0,180}browserIntroDismissedForPanel\s*=\s*true/);
});

test('sidepanel model selectors reset the active provider and Assist picker is compact and closeable', async () => {
  const [html, css, source] = await Promise.all([
    read('extension/sidepanel.html'),
    read('extension/sidepanel.css'),
    read('extension/sidepanel.js'),
  ]);
  assert.match(html, /id="modelMenuCloseButton"/);
  assert.match(source, /function setModelSelectionTarget\(/);
  assert.match(source, /setModelSelectionTarget\(['"]chat['"]\)/);
  assert.match(source, /setModelSelectionTarget\(['"]assist['"]\)/);
  assert.match(source, /modelProviderList\.scrollLeft\s*=\s*0/);
  assert.match(css, /\.model-menu\[data-selection-target="assist"\][\s\S]*max-height:\s*min\(/);
  assert.doesNotMatch(css, /\.model-menu\[data-selection-target="assist"\]\s*\{[^}]*max-height:\s*none/s);
  assert.match(css, /#inlineAssistModelButton\s*\{[^}]*font-family:\s*var\(--hermes-font-ui\)/s);
  assert.match(css, /\.model-menu\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(58px,\s*auto\)/s);
  assert.match(css, /\.model-provider-list\s*\{[^}]*min-height:\s*58px/s);
  assert.match(css, /\.model-effort-list\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s);
});

test('Hermes Assist model selectors remain available and explain gateway-default fallback', async () => {
  const [sidepanelHtml, sidepanelSource, helperSource] = await Promise.all([
    read('extension/sidepanel.html'),
    read('extension/sidepanel.js'),
    read('extension/content-inline-helper.js'),
  ]);
  assert.match(sidepanelHtml, /id="inlineAssistModelButton"[^>]*\sdisabled(?:\s|>)/);
  assert.match(sidepanelHtml, /id="assistModelCapabilityHint"/);
  assert.doesNotMatch(sidepanelSource, /inlineAssistModelButton\.disabled\s*=\s*true/);
  assert.match(sidepanelSource, /gateway default/i);
  assert.match(helperSource, /modelNotice/);
  assert.match(helperSource, /Model routing/i);
});

test('inline result controls use correct artwork, dismiss accepted drafts, and route retained sessions explicitly', async () => {
  const source = await read('extension/content-inline-helper.js');
  assert.match(source, /hermes-browser-extension-icon-ink\.png/);
  assert.doesNotMatch(source, /logoUrl[\s\S]{0,180}hermes-browser-extension-icon-box-white\.png/);
  assert.match(source, /function renderOpenSessionChoices\(/);
  assert.match(source, /surface:\s*['"]sidepanel['"]/);
  assert.match(source, /surface:\s*['"]web['"]/);
  assert.match(source, /\.result-actions\[data-action-count="3"\]/);
  const apply = source.match(/function applyResult\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert.match(apply, /hidePanel\(\)/);
});

test('session opening never silently falls back from Browser Extension to a full tab', async () => {
  const source = await read('extension/background.js');
  assert.match(source, /message\?\.surface\s*===\s*['"]web['"]/);
  assert.match(source, /openHermesPanel\(tab, \{ allowFallback: false \}\)/);
  // The web surface is the Hermes Webapp the user's gateway serves, opened through the shared opener; it never
  // builds the extension's own full-tab URL, and the side panel route above stays the only fallback-free path.
  assert.match(source, /openHermesWebapp\(\{[\s\S]{0,400}permissionMode: 'contains'/);
  assert.doesNotMatch(source.slice(source.indexOf('async function queueOpenSessionRequest'), source.indexOf('async function configureInstalledSurfaces')), /appUrl\.searchParams/);
});

test('Nous Light cards are solid white above the global texture layer in the side panel', async () => {
  const sidepanelCss = await read('extension/sidepanel-themes.css');
  assert.match(sidepanelCss, /data-hermes-mode="light"\]\s+\.message\.user\s*\{[^}]*background:\s*var\(--_user-tint\)\s*!important/s);
  assert.match(sidepanelCss, /data-hermes-theme="nous"\]\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-user-fg:\s*#0000f2/s);
  assert.match(sidepanelCss, /data-hermes-mode="light"\]\s+\.message\.user \.context-receipt summary\s*\{[^}]*color:\s*var\(--hermes-ink\)/s);
  assert.match(sidepanelCss, /data-hermes-theme="nous"\]\[data-hermes-mode="light"\][\s\S]*::selection\s*\{[^}]*background:\s*#EDFF45/i);
});

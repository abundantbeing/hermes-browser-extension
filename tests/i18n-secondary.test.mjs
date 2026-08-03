import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('permission status composites translate fixed copy without translating runtime errors', () => {
  const source = read('extension/request-permissions.js');
  assert.match(source, /import \{[^}]*\bt\b[^}]*\} from '\.\/lib\/i18n\.mjs';/s);
  assert.match(source, /t\('permissions\.state',\s*\{\s*state\s*\}\)/);
  assert.match(source, /t\('permissions\.not_granted',\s*\{\s*error:/);
  assert.doesNotMatch(source, /translateUiText\(`[^`]*\$\{error/s);
});

test('voice status composites preserve transcript and runtime error values', () => {
  const source = read('extension/voice-dictation.js');
  assert.match(source, /import \{[^}]*\bt\b[^}]*\} from '\.\/lib\/i18n\.mjs';/s);
  for (const key of [
    'voice.browser.preview',
    'voice.browser.stopped',
    'voice.transcript_sent',
    'voice.browser.start_failed',
    'voice.browser.stop_failed',
    'voice.transcription_failed',
    'voice.permission_blocked',
    'voice.start_failed',
    'voice.settings_load_failed',
  ]) {
    assert.match(source, new RegExp(`t\\('${escapeRegExp(key)}',\\s*\\{`), key);
  }
  assert.doesNotMatch(source, /translateUiText\(`[^`]*\$\{(?:error|transcript|preview)/s);
});

test('locale subscribers rerender application-owned dynamic regions without touching external values', () => {
  const app = read('extension/app.js');
  const sidepanel = read('extension/sidepanel.js');
  assert.match(app, /subscribeLocale\(\(\) => \{[\s\S]*renderAppearanceSettings\(\);[\s\S]*renderInlineAssistModelOptions\(\);[\s\S]*renderTaskStack\(\);[\s\S]*\}\);/);
  assert.match(sidepanel, /subscribeLocale\(\(\) => \{[\s\S]*renderGatewayHelp\(\);[\s\S]*renderContextScopeControls\(\);[\s\S]*renderTaskStack\(\);[\s\S]*\}\);/);
  for (const source of [app, sidepanel]) {
    assert.match(source, /const key = routingSupported \? 'assist\.routing\.exact' : 'assist\.routing\.fallback'/);
    assert.match(source, /const localized = t\(key\)/);
    assert.match(source, /ASSIST_ROUTING_FALLBACK_ENGLISH/);
  }
});

test('Hermes Web and attachment renderers localize fixed runtime fallbacks without translating truth values', () => {
  const app = read('extension/app.js');
  const sidepanel = read('extension/sidepanel.js');
  const appHtml = read('extension/app.html');
  const connectionMode = app.match(/function connectionModeLabel\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const connectionTruth = app.match(/function renderConnectionTruth\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const composerRuntime = app.match(/function renderComposerRuntimeControl\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  const pickState = sidepanel.match(/function setPickButtonState\([^)]*\)\s*\{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(connectionMode, /translateUiText\('Local gateway'\)/);
  assert.match(connectionMode, /translateUiText\('Remote gateway'\)/);
  assert.match(connectionTruth, /settings\.activeProfile \|\| translateUiText\('Default profile'\)/);
  assert.match(connectionTruth, /t\('context\.browser_tab_handoff',\s*\{\s*tabId:\s*handoff\.sourceTabId\s*\}\)/);
  assert.match(composerRuntime, /t\('runtime\.reasoning',\s*\{\s*effort:/);
  assert.match(composerRuntime, /translateUiText\('Thinking off'\)/);
  assert.match(composerRuntime, /translateUiText\('Fast mode'\)/);
  assert.match(composerRuntime, /translateUiText\('Standard'\)/);
  assert.match(composerRuntime, /t\('runtime\.model_control_title'/);
  for (const english of ['◈ Picking element...', '◈ Pick a different element', '◈ Pick page element']) {
    assert.match(pickState, new RegExp(`translateUiText\\('${escapeRegExp(english)}'\\)`));
  }
  assert.match(app, /t\('fulltab\.handoff\.opened_from_tab'/);
  assert.match(app, /t\('fulltab\.handoff\.opened_from'/);
  assert.match(app, /translateUiText\('Opened directly in full view\.'\)/);
  assert.match(appHtml, /id="taskStackSummary"[^>]*data-i18n="ui\.0\.complete\.0\.active"/);
});

test('Sidepanel status rendering never reverse-translates runtime errors, tab titles, URLs, or session truth', () => {
  const sidepanel = read('extension/sidepanel.js');
  assert.doesNotMatch(sidepanel, /error\?\.message \|\| String\(error\)\);/);
  assert.doesNotMatch(sidepanel, /error\?\.message \|\| String\(error\)\)\)\)/);
  assert.match(sidepanel, /diagnostic\.kind === 'unknown' \? diagnostic\.detail : translateUiText\(diagnostic\.detail\)/);
  assert.match(sidepanel, /tab\.title \|\| translateUiText\('Restricted page'\)[\s\S]*translateTitle: false, translateDetail: false/);
  assert.match(sidepanel, /session\.sourceLabel \|\| session\.source \|\| 'Hermes'[\s\S]*translateDetail: false/);
  assert.match(sidepanel, /t\('status\.profile_switch_unavailable', \{ error:/);
});

test('Hermes Web error rendering localizes fixed copy but preserves runtime error details verbatim', () => {
  const app = read('extension/app.js');
  assert.match(app, /function showError\(title, detail, \{ translateTitle = true, translateDetail = true \} = \{\}\)/);
  assert.match(app, /translateDetail \? translateUiText\(detail\) : String\(detail \|\| ''\)/);
  for (const title of ['Could not load this session', 'Hermes Cloud unavailable', 'Hermes gateway unavailable', 'Could not start draft', 'Hermes Web could not start']) {
    assert.match(app, new RegExp(`showError\\('${escapeRegExp(title)}',[^;]+translateDetail: false`));
  }
});

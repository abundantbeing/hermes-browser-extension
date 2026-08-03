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

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_THEME_END,
  AGENT_THEME_START,
  buildAgentThemePrompt,
  extractAgentThemeDocument,
} from '../extension/lib/agent-theme-authoring.mjs';

const palette = {
  canvas:'#ffffff',paper:'#f5f5f5',ink:'#111111',muted:'#595959',primary:'#0505e8',primaryDeep:'#03039b',onPrimary:'#ffffff',accent:'#ffd400',onAccent:'#111111',line:'#767676',input:'#ffffff',danger:'#b00020',onDanger:'#ffffff',shellForeground:'#ffffff',
};

const document = {
  schemaVersion: 1,
  name: 'Matrix terminal',
  description: 'Agent-authored semantic theme',
  colors: palette,
  darkColors: { ...palette, canvas:'#101114',paper:'#181a20',ink:'#f4f5f7',muted:'#b5bac4',primary:'#00aa55',primaryDeep:'#006633',onPrimary:'#101114',accent:'#7cff7c',onAccent:'#101114',line:'#777d8a',input:'#101114',danger:'#ff6b78',onDanger:'#101114',shellForeground:'#ffffff' },
};

test('agent theme prompt pins the semantic contract and exact response markers', () => {
  const prompt = buildAgentThemePrompt('old-school Windows media player with cobalt chrome');
  assert.match(prompt, /old-school Windows media player with cobalt chrome/);
  assert.match(prompt, new RegExp(AGENT_THEME_START));
  assert.match(prompt, new RegExp(AGENT_THEME_END));
  for (const key of Object.keys(palette)) assert.match(prompt, new RegExp(`\\b${key}\\b`));
  assert.match(prompt, /no CSS|no URLs|no scripts/i);
});

test('agent theme prompt rejects empty and oversized descriptions', () => {
  assert.throws(() => buildAgentThemePrompt(''), /description/i);
  assert.throws(() => buildAgentThemePrompt('x'.repeat(301)), /description/i);
});

test('agent theme response extracts and validates one marked document', () => {
  const response = `Theme ready.\n${AGENT_THEME_START}\n${JSON.stringify(document)}\n${AGENT_THEME_END}`;
  const result = extractAgentThemeDocument(response);
  assert.equal(result.name, 'Matrix terminal');
  assert.equal(result.darkColors.primary, '#00aa55');
});

test('agent theme response fails closed for missing, duplicated, malformed, or invalid payloads', () => {
  assert.throws(() => extractAgentThemeDocument(JSON.stringify(document)), /markers/i);
  assert.throws(() => extractAgentThemeDocument(`${AGENT_THEME_START}{}${AGENT_THEME_END}${AGENT_THEME_START}{}${AGENT_THEME_END}`), /exactly one/i);
  assert.throws(() => extractAgentThemeDocument(`${AGENT_THEME_START}{${AGENT_THEME_END}`), /JSON/i);
  assert.throws(() => extractAgentThemeDocument(`${AGENT_THEME_START}${JSON.stringify({ ...document, colors: { ...palette, canvas: 'red' } })}${AGENT_THEME_END}`), /validation/i);
});

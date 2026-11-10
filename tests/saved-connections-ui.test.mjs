import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const panel = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

const connectionsCode = panel.slice(
  panel.indexOf('function savedConnectionCard('),
  panel.indexOf('function reloadForSavedConnection('),
) + panel.slice(
  panel.indexOf('async function updateSavedConnection('),
  panel.indexOf('async function updateSavedConnection(') + 2500,
);

test('saved connections use the panel itself, never the browser\'s own dialogs', () => {
  assert.ok(connectionsCode.length > 3000, 'the saved-connections code was found');
  assert.doesNotMatch(connectionsCode, /window\.(prompt|confirm|alert)\(|[^.\w](prompt|confirm|alert)\(/);
});

test('the saved connections are cards, with the name field inline and Delete opening a window that lists them', () => {
  assert.match(html, /id="savedConnectionList"/);
  assert.doesNotMatch(html, /id="savedConnectionSelect"/);
  assert.match(html, /id="savedConnectionEditor"[^>]*hidden/);
  assert.doesNotMatch(html, /id="savedConnectionConfirm"/, 'Delete no longer asks about the connection in use');
  assert.match(html, /<section id="deleteConnectionDialog"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*hidden>/);
  assert.match(html, /id="deleteConnectionList"[^>]*role="radiogroup"/);
  assert.match(html, /id="deleteConnectionConfirm"[^>]*disabled/, 'nothing is chosen to begin with');
  assert.match(connectionsCode, /els\.savedConnectionDelete\?\.addEventListener\('click', openDeleteConnectionWindow\)/);
  assert.match(connectionsCode, /className = `conn-mode-card saved-connection-card/);
});

test('the name field never submits Settings, and Escape only closes the field', () => {
  const editor = html.slice(html.indexOf('id="savedConnectionEditor"'), html.indexOf('id="savedConnectionHelp"'));
  assert.doesNotMatch(editor, /<form|type="submit"/);
  assert.match(connectionsCode, /event\.key !== 'Enter'[\s\S]*event\.preventDefault\(\)[\s\S]*submitSavedConnectionName\(\)/);
  assert.match(connectionsCode, /event\.key !== 'Escape'[\s\S]*event\.stopPropagation\(\)[\s\S]*closeSavedConnectionTool\(\)/);
});

test('the two stacks of tiles are told apart by their headings', () => {
  assert.match(html, /<label id="savedConnectionLabel"/);
  assert.match(html, /<label id="connectionModeLabel"[^>]*data-i18n="ui\.connection\.mode"/);
  assert.match(html, /role="radiogroup" aria-labelledby="connectionModeLabel"/);
});

test('the connection tools show one state at a time and keep their controls square', () => {
  for (const selector of ['.saved-connection-actions', '.saved-connection-editor']) {
    assert.ok(css.includes(`${selector}[hidden]`), `${selector} can be hidden`);
  }
  const block = css.slice(css.indexOf('.saved-connection-list {'), css.indexOf('.saved-connection-editor input {') + 100);
  assert.doesNotMatch(block, /border-radius|text-transform|letter-spacing/);
});

test('Add opens a window of its own that makes a new connection, never a copy of the current one', () => {
  assert.match(html, /<section id="addConnectionDialog"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*hidden>/);
  assert.match(panel, /els\.savedConnectionAdd\?\.addEventListener\('click', openAddConnectionWindow\)/);
  assert.match(panel, /addSavedConnection\(base, name \|\| t\('connections\.default_name'[\s\S]*?crypto\.randomUUID\(\), connection\)/);
  assert.match(panel, /OVERLAY_SCROLL_AREAS = '[^']*\.add-connection-body/);
  const window = html.slice(html.indexOf('id="addConnectionDialog"'), html.indexOf('id="profileSwitchDialog"'));
  assert.doesNotMatch(window, /<form/, 'a form in here would be a form inside the Settings form');
});

test('a connection added without a key starts signing in when its panel opens, and leaves Settings closed', () => {
  assert.match(panel, /action === 'add' && connection && !connection\.apiKey\) \{\s*try \{ globalThis\.sessionStorage\?\.setItem\('hermesBrowserConnectAfterAdd', '1'\)/);
  assert.match(panel, /const connectAfterAdd = globalThis\.sessionStorage\?\.getItem\('hermesBrowserConnectAfterAdd'\) === '1';/);
  assert.match(panel, /if \(!connectAfterAdd\) openSettingsDialog\(\{ pane: 'connections' \}\);/);
  assert.match(panel, /if \(connectAfterAdd && !settings\.apiKey\) void connectToHermes\(\)/);
});

test('Options changes the connection in use through the same window, and Hermes Cloud has none', () => {
  assert.match(html, /<button id="savedConnectionOptions" type="button" data-i18n="connections\.options">/);
  assert.match(panel, /els\.savedConnectionOptions\?\.addEventListener\('click', openConnectionOptionsWindow\)/);
  assert.match(panel, /els\.savedConnectionOptions\.disabled = savedConnectionBusy \|\| settings\.connectionMode === 'cloud'/);
  assert.match(panel, /else if \(action === 'options'\) next = \{ \.\.\.base, connectionHeaders: options\.headers, connectionTrustSelfSigned: options\.trustSelfSigned \}/);
});


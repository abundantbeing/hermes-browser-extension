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

test('the saved connections are cards, with the name field and the delete question inline', () => {
  assert.match(html, /id="savedConnectionList"/);
  assert.doesNotMatch(html, /id="savedConnectionSelect"/);
  assert.match(html, /id="savedConnectionEditor"[^>]*hidden/);
  assert.match(html, /id="savedConnectionConfirm"[^>]*role="alertdialog"[^>]*hidden/);
  assert.match(connectionsCode, /className = `conn-mode-card saved-connection-card/);
});

test('the name field never submits Settings, and Escape only closes the field or the question', () => {
  const editor = html.slice(html.indexOf('id="savedConnectionEditor"'), html.indexOf('id="savedConnectionConfirm"'));
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
  for (const selector of ['.saved-connection-actions', '.saved-connection-editor', '.saved-connection-confirm']) {
    assert.ok(css.includes(`${selector}[hidden]`), `${selector} can be hidden`);
  }
  const block = css.slice(css.indexOf('.saved-connection-list {'), css.indexOf('.saved-connection-confirm p {') + 200);
  assert.doesNotMatch(block, /border-radius|text-transform|letter-spacing/);
});

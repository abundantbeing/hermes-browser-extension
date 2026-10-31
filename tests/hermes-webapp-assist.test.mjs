import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8');

test('the old "being worked on" copy is gone from the side panel, the Assist chooser and the background', () => {
  for (const file of ['sidepanel.html', 'sidepanel.js', 'content-inline-helper.js', 'background.js', 'lib/i18n-content.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /being worked on/i, file);
    assert.doesNotMatch(source, /no longer opens Hermes Web/i, file);
    assert.doesNotMatch(source, /web\.deprecation_body/, file);
  }
  assert.doesNotMatch(read('background.js'), /Choose Hermes Web instead/);
});

test('the Assist chooser opens Hermes Web through the background and handles every answer', () => {
  const helper = read('content-inline-helper.js');
  const background = read('background.js');
  assert.match(helper, /openResultSession\(option\.surface\)/);
  assert.match(helper, /Open the Hermes Web app in a new browser tab\./);
  assert.match(helper, /if \(response\?\.webapp\) renderWebappUnavailable\(response\)/);
  assert.match(helper, /surface === 'web' && response\.hint/);
  assert.match(helper, /activeView\.name === 'webapp-unavailable'/, 'it re-renders when the language changes');
  assert.match(helper, /hermes config set webapp\.enabled true/);
  assert.match(background, /import \{ isLocalGatewayConnection, openHermesWebapp \} from '\.\/lib\/hermes-webapp\.mjs'/);
  assert.match(background, /tickets: webappGatewayTickets,/, 'the paired gateway signs the tab in here too');
  assert.match(background, /permissionMode: 'contains'/);
  const handler = background.slice(background.indexOf('async function queueOpenSessionRequest'), background.indexOf('async function configureInstalledSurfaces'));
  assert.doesNotMatch(handler, /app\.html/);
});

// Test connection asks Hermes' origin gate up front, so a refused origin is named before the first send.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { sessionRouteOriginRefusal } from '../extension/lib/session-materialization.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const fn = (name) => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))?.[0] || '';

test('the probe is a side-effect-free OPTIONS to the origin gate, read with the refusal rule', () => {
  const probe = fn('probeApiOriginRefusal');
  assert.match(probe, /method: 'OPTIONS'/);
  assert.match(probe, /sessionRouteOriginRefusal\(\{/);
  assert.match(probe, /extensionOrigin: currentExtensionOrigin\(\)/);
  assert.match(probe, /catch \{\s*return null;/, 'a failed probe says nothing');
  // What the probe reads: Hermes' gate answers a refused origin with a bare 403; a gateway that
  // allows it answers 200, and one without the gate 404/405 or a JSON 403.
  assert.ok(sessionRouteOriginRefusal({ status: 403, body: '', extensionOrigin: 'chrome-extension://abc' }));
  for (const answer of [{ status: 200, body: '' }, { status: 405, body: '' }, { status: 403, body: '{"error":{}}' }]) {
    assert.equal(sessionRouteOriginRefusal(answer), null, JSON.stringify(answer));
  }
});

test('a refused origin turns a green test into a warning with the exact .env line', () => {
  const test = fn('testConnection');
  const probe = test.indexOf('await probeApiOriginRefusal()');
  assert.ok(probe > test.indexOf("setStatus(\n      'ok',"), 'after the connected status');
  assert.match(test, /const originRefusal = dashboardAttached \? null : await probeApiOriginRefusal\(\);/, 'not for the dashboard socket');
  assert.match(test, /'Hermes will refuse messages from this browser'/);
  assert.match(test, /\$\{originRefusal\.envLine\}/);
  assert.match(test, /ok = !originRefusal;/);
});

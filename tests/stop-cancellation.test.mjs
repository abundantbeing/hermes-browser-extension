import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Hermes Web stop click cancels the runtime run once and always aborts the local stream', () => {
  const js = read('extension/app.js');
  const start = js.indexOf('els.stopRun.addEventListener');
  const end = js.indexOf('els.attachButton.addEventListener', start);
  assert.ok(start >= 0 && end > start, 'expected the stopRun click handler in app.js');
  const handler = js.slice(start, end);

  assert.ok(handler.indexOf('if (activeRunId) {') < handler.indexOf('client.fetch'), 'the stop request must be guarded by an active run');
  assert.equal((handler.match(/\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}\/stop/g) || []).length, 1, 'the stop endpoint must be posted exactly once');
  assert.match(handler, /client\.fetch\(`\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}\/stop`, \{ method: 'POST' \}\)/);
  assert.match(handler, /\.then\(\(response\)\s*=>\s*\{[\s\S]*?if\s*\(!response\.ok\)\s*throw/);
  assert.match(handler, /\.catch\(\(error\)\s*=>\s*\{[\s\S]*?els\.composerStatus\.textContent\s*=\s*`Stop failed:/);
  assert.match(handler, /\n {2}\}\n {2}activeAbortController\?\.abort\(\);/);
});

test('side panel stop cancels the run once, only while sending, and surfaces stop failures', () => {
  const js = read('extension/sidepanel.js');
  const fn = js.match(/async function stopCurrentTurn\(\)\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.ok(fn, 'expected stopCurrentTurn in sidepanel.js');

  assert.match(fn, /if\s*\(!sending\)\s*return;/);
  assert.ok(fn.indexOf('if (activeRunId && !isRemoteWsMode()) {') < fn.indexOf('apiFetch'), 'the stop request must be guarded by an active local run');
  assert.equal((fn.match(/\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}\/stop/g) || []).length, 1, 'the stop endpoint must be posted exactly once');
  assert.match(fn, /apiFetch\(`\/v1\/runs\/\$\{encodeURIComponent\(activeRunId\)\}\/stop`, \{ method: 'POST' \}\)/);
  assert.match(fn, /\.then\(\(response\)\s*=>\s*\{[\s\S]*?if\s*\(!response\.ok\)\s*throw/);
  assert.match(fn, /\.catch\(\(error\)\s*=>\s*\{[\s\S]*?setStatus\('err',\s*'Stop request failed'/);
  assert.match(fn, /\n {2}\}\s*activeAbortController\?\.abort\(\);/);
});

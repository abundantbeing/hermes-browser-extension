// Moving to another gateway must not carry the old gateway's bot profile or pairing token along.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { gatewayMoveResets } from '../extension/lib/settings-save-effects.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const local = {
  gatewayUrl: 'http://127.0.0.1:8642', apiKey: 'paired-token', tokenSource: 'pairing',
  activeProfile: 'riku', botModeSelectedProfile: 'riku', botModeReturnProfile: 'default',
};

test('another gateway starts on its default profile and never gets the old pairing token', () => {
  const resets = gatewayMoveResets(local, { ...local, gatewayUrl: 'http://100.64.0.9:8642' });
  assert.deepEqual(resets, {
    activeProfile: '', botModeSelectedProfile: '', botModeReturnProfile: '', apiKey: '', tokenSource: '',
  });
});

test('a key the person typed stays: it is in the field they saved', () => {
  const typed = { ...local, apiKey: 'typed-key', tokenSource: 'manual' };
  const resets = gatewayMoveResets(typed, { ...typed, gatewayUrl: 'https://agent.example.com' });
  assert.equal('apiKey' in resets, false);
  assert.equal(resets.activeProfile, '');
  // A new token entered with the move is the person's choice too.
  assert.equal('apiKey' in gatewayMoveResets(local, { ...local, gatewayUrl: 'http://10.0.0.2:8642', apiKey: 'new', tokenSource: 'manual' }), false);
});

test('the same gateway, under another spelling, keeps everything', () => {
  for (const gatewayUrl of ['http://127.0.0.1:8642/', 'http://localhost:8642', 'http://[::1]:8642', 'http://127.0.0.1:8642/v1']) {
    assert.deepEqual(gatewayMoveResets(local, { ...local, gatewayUrl }), {}, gatewayUrl);
  }
  // Another port on loopback is another gateway.
  assert.equal(gatewayMoveResets(local, { ...local, gatewayUrl: 'http://127.0.0.1:8643' }).activeProfile, '');
});

test('Save and an unsaved Connect both apply the resets', () => {
  const save = source.slice(source.indexOf('async function saveSettingsFromForm('), source.indexOf('const connectionChanged = previousSettings.connectionMode'));
  assert.match(save, /const moved = gatewayMoveResets\(previousSettings, settings\);/);
  assert.match(save, /settings = \{ \.\.\.settings, \.\.\.moved \};/);
  // Without the old token a remote connection is the dashboard one, as with an empty key field.
  assert.match(save, /'apiKey' in moved && connectionMode === 'remote'[\s\S]*?CONNECTION_TRANSPORTS\.REMOTE_DASHBOARD/);
  const adopt = source.slice(source.indexOf('function adoptUnsavedGatewayUrlForConnect('), source.indexOf('void clearAccountForConnection();', source.indexOf('function adoptUnsavedGatewayUrlForConnect(')));
  assert.match(adopt, /gatewayMoveResets\(previous, settings\)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { hermesHomeCandidates, resolveHermesHome } from '../scripts/hermes-home.mjs';

const homedir = () => path.join('C:', 'Users', 'example');

test('HERMES_HOME overrides the platform default', () => {
  const candidates = hermesHomeCandidates({
    env: { HERMES_HOME: 'E:\\AI\\hermes-data', LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
    platform: 'win32',
    homedir,
  });
  assert.deepEqual(candidates, ['E:\\AI\\hermes-data']);
});

test('HERMES_HOME wins even when the default data dir exists', () => {
  const resolved = resolveHermesHome({
    env: { HERMES_HOME: 'E:\\AI\\hermes-data', LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
    platform: 'win32',
    homedir,
    exists: () => true,
  });
  assert.equal(resolved, 'E:\\AI\\hermes-data');
});

test('native Windows prefers %LOCALAPPDATA%\\hermes over ~/.hermes', () => {
  const localAppData = path.join('C:', 'Users', 'example', 'AppData', 'Local');
  const candidates = hermesHomeCandidates({ env: { LOCALAPPDATA: localAppData }, platform: 'win32', homedir });
  assert.deepEqual(candidates, [path.join(localAppData, 'hermes'), path.join(homedir(), '.hermes')]);
});

test('native Windows falls back to ~/.hermes when only the legacy dir exists', () => {
  const localAppData = path.join('C:', 'Users', 'example', 'AppData', 'Local');
  const legacy = path.join(homedir(), '.hermes');
  const resolved = resolveHermesHome({
    env: { LOCALAPPDATA: localAppData },
    platform: 'win32',
    homedir,
    exists: (candidate) => candidate === legacy,
  });
  assert.equal(resolved, legacy);
});

test('non-Windows platforms only consider ~/.hermes', () => {
  const candidates = hermesHomeCandidates({ env: {}, platform: 'linux', homedir });
  assert.deepEqual(candidates, [path.join(homedir(), '.hermes')]);
});

test('a blank HERMES_HOME is ignored', () => {
  const candidates = hermesHomeCandidates({ env: { HERMES_HOME: '   ' }, platform: 'linux', homedir });
  assert.deepEqual(candidates, [path.join(homedir(), '.hermes')]);
});

test('resolveHermesHome returns the first candidate when none exist', () => {
  const localAppData = path.join('C:', 'Users', 'example', 'AppData', 'Local');
  const resolved = resolveHermesHome({
    env: { LOCALAPPDATA: localAppData },
    platform: 'win32',
    homedir,
    exists: () => false,
  });
  assert.equal(resolved, path.join(localAppData, 'hermes'));
});

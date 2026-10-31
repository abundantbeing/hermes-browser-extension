import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { CHECK_JS_COMMANDS } from '../scripts/check-js.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('check:js runs its list from scripts/check-js.mjs', () => {
  assert.equal(packageJson.scripts['check:js'], 'node scripts/check-js.mjs');
  assert.equal(new Set(CHECK_JS_COMMANDS).size, CHECK_JS_COMMANDS.length, 'no command is listed twice');
  for (const command of CHECK_JS_COMMANDS) {
    const target = /^node --check (\S+)$/.exec(command)?.[1];
    if (target) assert.ok(existsSync(new URL(`../${target}`, import.meta.url)), `${target} exists`);
  }
});

test('every npm script fits the Windows command line', () => {
  // cmd.exe refuses a command longer than 8191 characters, and npm runs scripts through it on Windows.
  for (const [name, script] of Object.entries(packageJson.scripts)) {
    assert.ok(script.length < 8000, `${name} is ${script.length} characters`);
  }
});

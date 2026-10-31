import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactOpenOnComputerPolicy } from '../extension/lib/artifact-actions.mjs';
import english from '../extension/lib/locales/en.mjs';

test('programs, scripts and extensionless files are never handed to the OS handler', () => {
  for (const name of ['setup.exe', '/tmp/run.sh', 'C:\\Users\\me\\payload.PS1', 'installer.msi', 'macro.js', 'app.dmg', 'Makefile', 'notes.txt.lnk']) {
    assert.equal(artifactOpenOnComputerPolicy(name).blocked, true, name);
  }
});

test('ordinary documents are allowed but still go through the confirmation', () => {
  for (const name of ['report.pdf', '/home/user/out/chart.png', 'data.csv', 'notes.md']) {
    const policy = artifactOpenOnComputerPolicy(name);
    assert.equal(policy.blocked, false, name);
    assert.ok(policy.name, name);
  }
});

test('the open-on-computer confirmation and block messages carry the file name', () => {
  assert.match(english['ui.artifact.open_on_computer.confirm'], /\{name\}/);
  assert.match(english['ui.artifact.open_on_computer.blocked'], /\{name\}/);
});

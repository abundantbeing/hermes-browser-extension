import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { revealArtifactOnComputer, artifactRevealCommand } from '../extension/lib/artifact-folder.mjs';

const source = 'C:/Reports/Quarterly report.md';
test('folder action uses the original path through local shell RPC without downloading', async () => {
  const calls = [];
  const client = { request: async (method, params) => { calls.push({ method, params }); return { code: 0, stdout: '{"revealed":true}', stderr: '' }; } };
  await revealArtifactOnComputer(source, { gatewayUrl: 'http://127.0.0.1:8642', getClient: async () => client, verifyFile: async () => ({ ok: true }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'shell.exec');
  assert.equal(calls[0].params.command, artifactRevealCommand(source));
  assert.equal(calls[0].params.command, 'start "" explorer.exe /select,"C:\\Reports\\Quarterly report.md"');
});

test('remote or credential-bearing gateway never receives a folder-reveal command', async () => {
  for (const gatewayUrl of ['https://remote.example', 'http://user:pass@localhost:8642', 'http://localhost.attacker.example']) {
    await assert.rejects(revealArtifactOnComputer(source, { gatewayUrl, getClient: () => assert.fail('must not connect') }), /local Hermes/);
  }
});

test('Windows paths cannot inject shell commands or environment expansion', () => {
  for (const path of ['C:/Reports/a" & calc.exe.md', 'C:/Reports/%TEMP%.md', 'C:/Reports/!VAR!.md', 'C:/Reports/$(calc).md', 'C:/Reports/`calc`.md']) {
    assert.throws(() => artifactRevealCommand(path), /safe file path/);
  }
  assert.equal(artifactRevealCommand('C:/Reports/R&D report.md'), 'start "" explorer.exe /select,"C:\\Reports\\R&D report.md"');
});

test('URLs, relative paths and control characters are refused', () => {
  for (const path of ['https://example.com/report.pdf', 'report.pdf', 'C:/Reports/file.md\nother', 'C:/Reports/file.md\u0000']) {
    assert.throws(() => artifactRevealCommand(path), /absolute file path/);
  }
});

test('folder action requires an explicit successful command acknowledgement', async () => {
  for (const result of [{ code: 1, stderr: 'File not found' }, { stdout: '' }, null]) {
    await assert.rejects(revealArtifactOnComputer(source, {
      gatewayUrl: 'http://localhost:8642', getClient: async () => ({ request: async () => result }), verifyFile: async () => ({ ok: true }),
    }), /folder|File not found/);
  }
});

test('a missing file cannot launch the file manager', async () => {
  await assert.rejects(revealArtifactOnComputer(source, {
    gatewayUrl: 'http://localhost:8642', getClient: async () => ({ request: () => assert.fail('must not launch') }),
    verifyFile: async () => ({ ok: false, reason: 'http-404' }),
  }), /file|folder/i);
});

test('folder launch uses no script interpreter or inline execution flag', () => {
  assert.doesNotMatch(artifactRevealCommand(source), /python|powershell| -c | -e |EncodedCommand/);
});

test('the side-panel handler delegates to folder reveal rather than downloads.open', () => {
  for (const path of ['../extension/sidepanel.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const handler = source.match(/async function openArtifactCardOnComputer\(plan\) \{([\s\S]*?)\n\}/)?.[1] || '';
    assert.match(handler, /revealArtifactOnComputer\(plan.source/);
    assert.doesNotMatch(handler, /download|artifactDownloadUrlFor|fulltabArtifactDownloadUrlFor/);
  }
});

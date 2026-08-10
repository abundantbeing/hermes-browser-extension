import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEB_COMMANDS,
  parseWebCommand,
  webComposerSuggestionMode,
  webCommandSuggestions,
} from '../extension/lib/web-commands.mjs';
import {
  artifactActionState,
  describeArtifact,
  toFileUrl,
} from '../extension/lib/web-artifacts.mjs';
import { isRenderableAssistantMessage } from '../extension/lib/web-run-state.mjs';

test('Hermes Web shares the unified Browser registry while preserving full-tab actions', () => {
  const nativeNames = WEB_COMMANDS.filter((command) => command.kind === 'native').map((command) => command.name);
  const helperNames = WEB_COMMANDS.filter((command) => command.kind === 'helper').map((command) => command.name);

  for (const name of ['help', 'sessions', 'new', 'retry', 'model', 'provider', 'reset', 'rollback', 'steer', 'stop', 'queue', 'skills', 'quit', 'context', 'activity', 'attach', 'settings']) {
    assert.ok(nativeNames.includes(name), `Hermes Web should expose /${name}`);
  }
  for (const name of ['summarize', 'tldr', 'explain']) {
    assert.ok(helperNames.includes(name), `Hermes Web should preserve /${name}`);
  }

  const context = parseWebCommand('/context');
  assert.equal(context.kind, 'native');
  assert.equal(context.command.action, 'context-window');
  assert.equal(parseWebCommand('/summarize'), null, 'prompt helpers stay out of the native dispatch seam');
  assert.deepEqual(webCommandSuggestions('/activity').map((command) => command.name), ['activity']);
});

test('the Web command button stays command-only while typed slash and at-sign input can invoke skills', () => {
  assert.equal(webComposerSuggestionMode('', { force: true }), 'commands');
  assert.equal(webComposerSuggestionMode('/'), 'typed');
  assert.equal(webComposerSuggestionMode('/seo'), 'typed');
  assert.equal(webComposerSuggestionMode('@seo'), 'typed');
  assert.equal(webComposerSuggestionMode('Explain this'), 'none');
});

test('assistant transcript entries require real text or a real media reference', () => {
  assert.equal(isRenderableAssistantMessage({ role: 'assistant', content: '' }), false);
  assert.equal(isRenderableAssistantMessage({ role: 'assistant', content: '   ' }), false);
  assert.equal(isRenderableAssistantMessage({ role: 'assistant', content: 'MEDIA:C:\\Users\\Jaybo\\report.pdf' }), true);
  assert.equal(isRenderableAssistantMessage({ role: 'assistant', content: 'Finished the report.' }), true);
});

test('artifact affordances distinguish local paths, remote URLs, and unexported remote-runtime files', () => {
  const local = describeArtifact('C:\\Users\\example\\Documents\\brief.pdf');
  assert.equal(local.kind, 'local');
  assert.equal(local.name, 'brief.pdf');
  assert.equal(toFileUrl(local.source), 'file:///C:/Users/example/Documents/brief.pdf');
  assert.deepEqual(artifactActionState(local, { localGateway: true }), {
    canDownload: true,
    canOpen: true,
    unavailableReason: '',
  });

  const remote = describeArtifact('https://cdn.example.com/report.pdf');
  assert.equal(remote.kind, 'remote');
  assert.deepEqual(artifactActionState(remote, { localGateway: false }), {
    canDownload: true,
    canOpen: true,
    unavailableReason: '',
  });

  assert.deepEqual(artifactActionState(local, { localGateway: false }), {
    canDownload: false,
    canOpen: false,
    unavailableReason: 'This file lives on the connected runtime. The gateway has not exposed a downloadable URL yet.',
  });
});

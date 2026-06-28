import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_COMMANDS,
  getCommand,
  parseCommandInput,
  resolveCommandPrompt,
  suggestCommands,
} from '../extension/lib/commands.mjs';

const commandContext = {
  activeTab: { title: 'Example Page', url: 'https://example.com' },
  tabs: [
    { title: 'Example Page', url: 'https://example.com', active: true },
    { title: 'Docs', url: 'https://docs.example.com' },
  ],
  pageContext: {},
  settings: {},
};

test('built-in command registry exposes stable visible commands', () => {
  const names = BUILTIN_COMMANDS.map((command) => command.name);
  assert.ok(names.includes('summarize'));
  assert.ok(names.includes('tldr'));
  assert.ok(names.includes('extract'));
  assert.ok(names.includes('translate'));
  assert.ok(names.includes('explain'));
  assert.ok(names.includes('tabs'));
});

test('command lookup supports slash prefixes and aliases', () => {
  assert.equal(getCommand('/summarize')?.name, 'summarize');
  assert.equal(getCommand('summary')?.name, 'summarize');
  assert.equal(getCommand('/missing'), undefined);
});

test('parseCommandInput returns command and user tail only for known commands', () => {
  const parsed = parseCommandInput('/translate Spanish');
  assert.equal(parsed.command.name, 'translate');
  assert.equal(parsed.userInput, 'Spanish');
  assert.equal(parseCommandInput('plain request'), null);
  assert.equal(parseCommandInput('/unknown thing'), null);
});

test('resolveCommandPrompt appends user input without losing command context', () => {
  const result = resolveCommandPrompt('/extract', 'emails only', commandContext);
  assert.equal(result.command.name, 'extract');
  assert.match(result.prompt, /Example Page/);
  assert.match(result.prompt, /emails only/);
});

test('suggestCommands searches names, aliases, and descriptions', () => {
  assert.equal(suggestCommands('/sum')[0].name, 'summarize');
  assert.equal(suggestCommands('/summary')[0].name, 'summarize');
  assert.ok(suggestCommands('/links').some((command) => command.name === 'extract'));
});

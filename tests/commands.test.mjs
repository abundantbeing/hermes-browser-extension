import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
  assert.ok(names.includes('meta'));
});

test('publicly advertised quick commands are backed by the built-in registry', () => {
  const docs = [
    readFileSync(new URL('../README.md', import.meta.url), 'utf8'),
    readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  ].join('\n');
  const advertised = [...docs.matchAll(/`\/(summarize|explain|rewrite|tabs|action-items)`/g)]
    .map((match) => match[1]);
  const uniqueAdvertised = [...new Set(advertised)];
  const registryNames = new Set(BUILTIN_COMMANDS.map((command) => command.name));

  assert.deepEqual(uniqueAdvertised.sort(), ['action-items', 'explain', 'rewrite', 'summarize', 'tabs']);
  for (const name of uniqueAdvertised) {
    assert.ok(registryNames.has(name), `/${name} should exist in BUILTIN_COMMANDS`);
  }
});

test('command lookup supports slash prefixes and aliases', () => {
  assert.equal(getCommand('/summarize')?.name, 'summarize');
  assert.equal(getCommand('summary')?.name, 'summarize');
  assert.equal(getCommand('/metadata')?.name, 'meta');
  assert.equal(getCommand('head')?.name, 'meta');
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
  assert.ok(suggestCommands('/metadata').some((command) => command.name === 'meta'));
});

test('/meta command stays truthful about captured metadata limits', () => {
  const result = resolveCommandPrompt('/meta', '', commandContext);
  assert.equal(result.command.name, 'meta');
  assert.match(result.prompt, /Use only data that is actually present in the Browser context/);
  assert.match(result.prompt, /Do not imply Hermes Browser Extension captured raw <head> HTML/);
  assert.match(result.prompt, /Not captured/);
});

test('composer command menu exposes full hover and focus descriptions', () => {
  const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

  assert.match(js, /quick-command-detail/);
  assert.match(js, /showQuickCommandDetail/);
  assert.match(js, /promptHint/);
  assert.match(js, /mouseenter/);
  assert.match(js, /focus/);
  assert.match(js, /aria-describedby/);
  assert.match(js, /showQuickCommandDetail\(commands\[0\]\)/);
  assert.doesNotMatch(js, /item\.title\s*=/);
  assert.doesNotMatch(js, /item\.setAttribute\(['"]title['"]\)/);
  assert.match(css, /\.quick-command-detail/);
  assert.match(css, /\.quick-more-menu\.has-command-detail/);
  assert.match(css, /\.quick-command-detail\s*\{[^}]*height:\s*108px/s);
  assert.match(css, /\.quick-command-detail\s*\{[^}]*transition:\s*none/s);
  assert.match(css, /\.quick-more-menu\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.quick-command-list\s*\{[^}]*overflow-y:\s*auto/s);
  assert.doesNotMatch(css, /\.qmi-description\s*\{[^}]*white-space:\s*normal/s);
});

test('v0.1.10 CSS skeleton polish is additive and reduced-motion safe', () => {
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /@keyframes skeletonPulse/);
  assert.match(css, /@keyframes skeletonShimmer/);
  assert.match(css, /\.skeleton\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.skeleton::after\s*\{[^}]*animation:\s*skeletonShimmer/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*animation-duration:\s*0\.01ms !important/);
});

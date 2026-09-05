import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildProfileContextHandoff,
  profileContextHandoffForSession,
  shouldPromptForProfileSwitch,
} from '../extension/lib/profile-switch.mjs';

const sidepanelSource = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const sidepanelHtml = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const sidepanelCss = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

test('profile switching prompts only when a populated session crosses profile boundaries', () => {
  assert.equal(shouldPromptForProfileSwitch({ currentProfile: '', nextProfile: 'namine', messages: [] }), false);
  assert.equal(shouldPromptForProfileSwitch({ currentProfile: '', nextProfile: 'namine', messages: [{ role: 'system', content: 'status' }] }), false);
  assert.equal(shouldPromptForProfileSwitch({ currentProfile: '', nextProfile: 'namine', messages: [{ role: 'user', content: 'Hello' }] }), true);
  assert.equal(shouldPromptForProfileSwitch({ currentProfile: 'namine', nextProfile: 'namine', messages: [{ role: 'user', content: 'Hello' }] }), false);
});

test('profile context handoff is bounded, labeled as reference, and keeps the source identity', () => {
  const handoff = buildProfileContextHandoff({
    fromProfile: '',
    sessionId: 'hermes-browser-extension-123',
    messages: [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'system', content: 'Do not include this runtime status.' },
      { role: 'user', content: 'Latest question' },
    ],
  });

  assert.match(handoff, /Previous Hermes Browser session: hermes-browser-extension-123/);
  assert.match(handoff, /Previous profile: Default profile/);
  assert.match(handoff, /reference context only/i);
  assert.match(handoff, /USER: First question/);
  assert.match(handoff, /HERMES: First answer/);
  assert.match(handoff, /USER: Latest question/);
  assert.doesNotMatch(handoff, /Do not include this runtime status/);
});

test('profile context handoff keeps the newest bounded content when history exceeds the cap', () => {
  const handoff = buildProfileContextHandoff({
    fromProfile: 'riku',
    sessionId: 'session-long',
    maxChars: 360,
    messages: [
      { role: 'user', content: 'old '.repeat(40) },
      { role: 'assistant', content: 'newest answer' },
    ],
  });

  assert.match(handoff, /newest answer/);
  assert.match(handoff, /earlier context omitted/i);
  assert.ok(handoff.length <= 360);
});

test('profile context handoff is consumed only by its bound session', () => {
  const settings = {
    pendingProfileContextHandoff: 'reference context',
    pendingProfileContextHandoffSessionId: 'new-session',
  };
  assert.equal(profileContextHandoffForSession(settings, 'new-session'), 'reference context');
  assert.equal(profileContextHandoffForSession(settings, 'other-session'), '');
  assert.equal(profileContextHandoffForSession(settings, ''), '');
  assert.equal(profileContextHandoffForSession({ ...settings, pendingProfileContextHandoffSessionId: '' }, 'new-session'), '');
});

test('regular profile selection uses the transactional switch controller and binds every dialog action', () => {
  const handler = sidepanelSource.match(/els\.profileSelect\?\.addEventListener\('change',[\s\S]*?\n\s*\}\);/)?.[0] || '';
  assert.match(handler, /handleRegularProfileSelection\(/);
  assert.doesNotMatch(handler, /applySelectedProfile\(/);
  assert.match(sidepanelSource, /els\.profileSwitchCarryButton\?\.addEventListener\('click'/);
  assert.match(sidepanelSource, /els\.profileSwitchCleanButton\?\.addEventListener\('click'/);
  assert.match(sidepanelSource, /els\.profileSwitchCancelButton\?\.addEventListener\('click'/);
  assert.match(sidepanelSource, /pendingProfileContextHandoffSessionId/);
  assert.equal((sidepanelSource.match(/els\.botModeThreadsButton\?\.addEventListener\('click'/g) || []).length, 1);
  assert.equal((sidepanelSource.match(/els\.botModeNewThreadButton\?\.addEventListener\('click'/g) || []).length, 1);
  assert.equal((sidepanelSource.match(/els\.botModeReturnButton\?\.addEventListener\('click'/g) || []).length, 1);
  assert.match(sidepanelHtml, /id="profileSwitchDialog"[^>]*aria-describedby="profileSwitchDetail"/);
  assert.match(sidepanelHtml, /id="botModeLeaveDialog"/);
  assert.match(sidepanelHtml, /id="groupSettingsModal"/);
});

test('dynamic Ask <Agent> buttons adapt to the active bot and regular session state', () => {
  assert.match(sidepanelSource, /function updateComposerActionLabels\(\)/);
  assert.match(sidepanelSource, /ASK \$\{botName\.toUpperCase\(\)\}/);
  assert.match(sidepanelSource, /botName\.length > 10 \? 'Ask' : `Ask \$\{botName\}`/);
  assert.match(sidepanelSource, /els\.composerLabel\.textContent = 'ASK HERMES'/);
  assert.match(sidepanelSource, /els\.sendButton\.textContent = 'Ask Hermes'/);
});

test('new session button in Bot Mode prompts with on-brand exit dialog', () => {
  assert.match(sidepanelSource, /function openBotModeLeaveDialog\(\)/);
  assert.match(sidepanelSource, /function closeBotModeLeaveDialog\(\)/);
  assert.match(sidepanelSource, /if \(isBotModeEngaged\(\)\) \{\s*openBotModeLeaveDialog\(\);/);
  assert.match(sidepanelHtml, /id="botModeLeaveConfirmButton"/);
  assert.match(sidepanelHtml, /id="botModeLeaveCancelButton"/);
});

test('opening a bot profile cleanly tears down active group projection and resets placeholder', () => {
  const openProfileBody = sidepanelSource.match(/async function openBotProfile\([\s\S]*?(?=\nasync function )/)?.[0] || '';
  assert.match(openProfileBody, /activeGroupProjection = null;/);
  assert.match(openProfileBody, /activeGroupMessages = \[\];/);
  assert.match(sidepanelSource, /els\.input\.placeholder = botName/);
  assert.match(sidepanelSource, /Ask \$\{botName\}\.\.\./);
  assert.match(sidepanelSource, /persistGroupProjectionRename/);
});

test('theme palettes define accessible high-contrast message card variables in light mode', () => {
  const themesCss = readFileSync(new URL('../extension/sidepanel-themes.css', import.meta.url), 'utf8');
  assert.match(themesCss, /html\[data-hermes-theme="midnight"\]\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-user-bg:\s*#2a1a69/);
  assert.match(themesCss, /html\[data-hermes-theme="midnight"\]\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-user-fg:\s*#ffffff/);
  assert.match(themesCss, /html\[data-hermes-theme="ember"\]\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-user-bg:\s*#651b00/);
  assert.match(themesCss, /html\[data-hermes-theme="mono"\]\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-user-bg:\s*#1d1d1d/);
  assert.match(themesCss, /html\[data-hermes-theme="cyberpunk"\]\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-user-bg:\s*#005e25/);
  assert.match(themesCss, /html\[data-hermes-theme="slate"\]\[data-hermes-mode="light"\]\s*\{[^}]*--hermes-user-bg:\s*#1d3848/);
  assert.match(sidepanelCss, /\.message\.assistant \{[^}]*color:\s*var\(--hermes-ink/);
});

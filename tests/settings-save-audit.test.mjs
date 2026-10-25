import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createSettingsSaveHarness, sidepanelHtml, sidepanelSource } from './helpers/settings-save-harness.mjs';

const inlineHelper = readFileSync(new URL('../extension/content-inline-helper.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = sidepanelSource.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `${name} not found in sidepanel.js`);
  return sidepanelSource.slice(start, sidepanelSource.indexOf('\n}\n', start) + 2);
}

const formDocument = new JSDOM(sidepanelHtml).window.document;
const form = formDocument.getElementById('settingsForm');
const controls = [...form.querySelectorAll('input, select, textarea')]
  .filter((control) => !['file', 'button', 'search'].includes(control.type));
const isLive = (control) => Boolean(control.closest('[data-settings-live]'));

// els.<property> for an id or a radio group's name.
const propertyFor = new Map();
for (const match of sidepanelSource.matchAll(/\b([A-Za-z_$][\w$]*):\s*\$\('#([^']+)'\)/g)) propertyFor.set(`#${match[2]}`, match[1]);
for (const match of sidepanelSource.matchAll(/\b([A-Za-z_$][\w$]*):\s*Array\.from\(document\.querySelectorAll\('input\[name="([^"]+)"\]'\)\)/g)) propertyFor.set(`name:${match[2]}`, match[1]);
const keyOf = (control) => (control.id ? `#${control.id}` : `name:${control.name}`);

const SAVE_READERS = functionSource('saveSettingsFromForm');

// Controls that apply when changed, with the handler that saves each one.
const LIVE_HANDLERS = [
  'textZoomInput', 'fontProfileSelect', 'customFontFamilyInput', 'languageSelect',
  'profileSelect', 'agentHostInput', 'agentSchemeInput', 'agentPortsInput',
  'botModeEnabledInput', 'botModeDisplayDensity', 'botModeAnimateAvatars',
  'browserControlScopeInput', 'browserContextConsentInput', 'gmailCaptureEnabledInput',
];

test('every control in the settings form is either saved by Save or marked as applying itself', () => {
  assert.ok(controls.length > 40, 'the form should expose its controls');
  const unread = [];
  for (const control of controls) {
    if (isLive(control)) continue;
    const property = propertyFor.get(keyOf(control));
    if (!property || !new RegExp(`els\\.${property}\\b`).test(SAVE_READERS)) unread.push(keyOf(control));
  }
  assert.deepEqual(unread, [], 'these controls need Save but saveSettingsFromForm never reads them');
});

test('controls marked as applying themselves really save on change', () => {
  for (const id of LIVE_HANDLERS) {
    const control = formDocument.getElementById(id);
    assert.ok(control, `${id} should be in the form`);
    const property = propertyFor.get(`#${id}`);
    assert.match(sidepanelSource, new RegExp(`els\\.${property}\\?\\.addEventListener\\('change'`), `${id} must save itself on change`);
  }
});

test('whole panes of instant controls, and nothing else, are excluded as live', () => {
  const livePanes = [...form.querySelectorAll('[data-settings-pane][data-settings-live]')].map((pane) => pane.dataset.settingsPane);
  assert.deepEqual(livePanes.sort(), ['agents', 'appearance']);
  const livePaneIds = new Set(livePanes);
  const single = controls.filter((control) => isLive(control) && !livePaneIds.has(control.closest('[data-settings-pane]')?.dataset.settingsPane)).map((control) => control.id);
  assert.deepEqual(single.sort(), [
    'agentHostInput', 'agentPortsInput', 'agentSchemeInput', 'browserContextConsentInput',
    'browserControlScopeInput', 'gatewayModeInput', 'gmailCaptureEnabledInput', 'profileSelect',
  ]);
});

test('Unsaved edits counts only what needs Save and clears after a Save', async () => {
  const h = await createSettingsSaveHarness({ settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local' } });
  try {
    const dirtyPanes = () => [...h.document.querySelectorAll('[data-settings-pane]')]
      .filter((pane) => !pane.querySelector('.settings-pane-edited').hidden)
      .map((pane) => pane.dataset.settingsPane);
    h.fn('captureSettingsBaseline')();
    assert.deepEqual(dirtyPanes(), []);

    // Instant-apply controls saved themselves already.
    h.els.textZoomInput.value = '130';
    h.els.botModeDisplayDensity.value = 'compact';
    h.els.agentHostInput.value = 'macbook.tailnet.ts.net';
    h.els.browserControlScopeInput.value = 'selected-tabs';
    h.els.gmailCaptureEnabledInput.checked = true;
    h.fn('renderSettingsEditedMarkers')();
    assert.deepEqual(dirtyPanes(), [], 'instant-apply edits must not read as unsaved');

    // These only take effect on Save.
    h.els.gatewayUrlInput.value = 'http://10.0.0.5:9000';
    h.els.sessionTitleInput.value = 'Renamed';
    h.els.wakeWordEnabledInput.checked = true;
    h.fn('renderSettingsEditedMarkers')();
    assert.deepEqual(dirtyPanes().sort(), ['connections', 'sessions', 'voice']);

    await h.save();
    h.fn('captureSettingsBaseline')();
    assert.deepEqual(dirtyPanes(), [], 'a successful Save clears every unsaved marker');
  } finally {
    h.close();
  }
});

// What each Save-dependent control writes. The harness runs the shipped
// saveSettingsFromForm() over the shipped form, so a control Save forgot
// to read fails here.
const PERSISTED = [
  ['sessionIdInput', 'value', 'browser-session-9', 'sessionId', 'browser-session-9'],
  ['sessionTitleInput', 'value', 'Reading list', 'sessionTitle', 'Reading list'],
  ['autoNameSessionsInput', 'checked', false, 'autoNameSessions', false],
  ['showMessageTimesInput', 'checked', false, 'showMessageTimes', false],
  ['includeTabsInput', 'checked', true, 'includeTabs', true],
  ['includePageTextInput', 'checked', true, 'includePageText', true],
  ['includeSelectedTextInput', 'checked', true, 'includeSelectedText', true],
  ['inlineAssistEnabled', 'checked', false, 'inlineAssistEnabled', false],
  ['inlineAssistDefaultRoute', 'value', 'background', 'inlineAssistDefaultRoute', 'background'],
  ['inlineAssistSessionRetention', 'value', 'delete', 'inlineAssistSessionRetention', 'delete'],
  ['contextMenuDefaultRoute', 'value', 'new', 'contextMenuDefaultRoute', 'new'],
  ['wakeWordEnabledInput', 'checked', true, 'wakeWordEnabled', true],
  ['wakeWordPhraseInput', 'value', '  Hey   Hermes ', 'wakeWordPhrase', 'hey hermes'],
  ['wakeWordBrowserFallbackInput', 'checked', false, 'wakeWordBrowserFallback', false],
  ['wakeWordSpeakRepliesInput', 'checked', false, 'wakeWordSpeakReplies', false],
  ['hermesWebAddressInput', 'value', '  https://web.example.com/hermes  ', 'hermesWebAddress', 'https://web.example.com/hermes'],
  ['webappKeepSignedInInput', 'checked', false, 'webappKeepSignedIn', false],
  ['webappKeepSignedInInput', 'checked', true, 'webappKeepSignedIn', true],
  ['agentHostInput', 'value', 'macbook.tailnet.ts.net', 'agentDiscoveryHost', 'macbook.tailnet.ts.net'],
  ['agentSchemeInput', 'value', 'https', 'agentDiscoveryScheme', 'https'],
  ['agentPortsInput', 'value', '9001, 9002', 'agentPorts', [9001, 9002]],
  ['customModelSourcesInput', 'value', 'http://192.168.1.4:1234/v1', 'customModelSources', ['http://192.168.1.4:1234/v1/models']],
  ['botModeEnabledInput', 'checked', true, 'botModeEnabled', true],
  ['botModeDisplayDensity', 'value', 'compact', 'botModeDisplayDensity', 'compact'],
  ['botModeAnimateAvatars', 'value', 'on', 'botModeAnimateAvatars', true],
  ['gmailCaptureEnabledInput', 'checked', true, 'gmailCaptureEnabled', true],
];

for (const [id, prop, value, key, expected] of PERSISTED) {
  test(`Save persists ${id} as ${key}`, async () => {
    const h = await createSettingsSaveHarness({ settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local' } });
    try {
      h.els[id][prop] = value;
      await h.save();
      assert.deepEqual(h.store.hermesBrowserSettings[key], expected);
      assert.deepEqual(h.scope.settings[key], expected, 'the running panel uses the saved value without a reload');
    } finally {
      h.close();
    }
  });
}

test('Save persists the radio choices: context depth, transcripts, panel residency', async () => {
  const h = await createSettingsSaveHarness({ settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local' } });
  try {
    const choose = (group, value) => h.els[group].forEach((input) => { input.checked = input.value === value; });
    choose('contextDepthInputs', 'full');
    choose('transcriptModeInputs', 'custom');
    h.els.transcriptProviderInput.value = 'https://transcripts.example.com/api';
    choose('panelResidencyInputs', 'global');
    await h.save();
    const saved = h.store.hermesBrowserSettings;
    assert.equal(saved.contextDepth, 'full');
    assert.equal(saved.transcriptProvider, 'https://transcripts.example.com/api');
    assert.equal(saved.panelResidencyMode, 'global');

    choose('transcriptModeInputs', 'off');
    await h.save();
    assert.equal(h.store.hermesBrowserSettings.transcriptProvider, 'off');
  } finally {
    h.close();
  }
});

test('a saved gateway URL and key are what the next request uses', async () => {
  const h = await createSettingsSaveHarness({ settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local', apiKey: 'sk-old' } });
  try {
    h.els.gatewayUrlInput.value = 'http://10.0.0.5:9000';
    h.els.apiKeyInput.value = 'sk-new';
    await h.save();
    assert.equal(h.store.hermesBrowserSettings.gatewayUrl, 'http://10.0.0.5:9000');
    assert.equal(h.store.hermesBrowserSettings.apiKey, 'sk-new');
    assert.equal(h.callsTo('connectionController.cancel').length, 1, 'a changed connection drops the in-flight probe');

    await h.client.fetch('/health');
    const [url, init] = h.callsTo('fetch')[0].args;
    assert.equal(url, 'http://10.0.0.5:9000/health');
    assert.equal(init.headers.Authorization, 'Bearer sk-new');
  } finally {
    h.close();
  }
});

test('a saved connection mode and wake word take effect through the follow-up actions Save runs', async () => {
  const h = await createSettingsSaveHarness({ settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local' } });
  try {
    h.els.connectionModeInput.value = 'remote';
    h.els.gatewayUrlInput.value = 'https://hermes.example.com';
    h.els.apiKeyInput.value = 'sk-remote';
    h.els.wakeWordEnabledInput.checked = true;
    h.els.botModeEnabledInput.checked = false;
    await h.save();
    const saved = h.store.hermesBrowserSettings;
    assert.equal(saved.connectionMode, 'remote');
    assert.equal(saved.gatewayUrl, 'https://hermes.example.com');
    assert.equal(h.callsTo('connectionController.cancel').length, 1);
    assert.deepEqual(h.callsTo('setWakeWordEnabled').map((call) => call.args[0]), [true], 'turning the wake word on starts it now');
    assert.equal(h.callsTo('applyAppearanceSettings').length, 1, 'message-time visibility is re-applied by Save');
    assert.ok(h.callsTo('syncSettingsForm').length >= 1, 'the form is re-read from what was stored');
  } finally {
    h.close();
  }
});

test('settings that Save writes have a consumer that reads them live', () => {
  // The panel reads these from the running `settings` object on every use.
  assert.match(sidepanelSource, /getConnection: \(\) => settings/);
  assert.match(sidepanelSource, /settings\.autoNameSessions === false/);
  assert.match(functionSource('applyAppearanceSettings'), /hide-message-times', settings\.showMessageTimes === false/);
  assert.match(sidepanelSource, /normalizeExternalModelSourceList\(settings\.customModelSources/);
  assert.match(sidepanelSource, /const provider = settings\.transcriptProvider/);
  // Assist and the right-click menu live in other contexts: they follow storage.
  assert.match(inlineHelper, /changes\.hermesBrowserSettings\.newValue/);
  assert.match(readFileSync(new URL('../extension/lib/context-menu-controller.mjs', import.meta.url), 'utf8'), /hermesBrowserSettings\?\.contextMenuDefaultRoute/);
  assert.match(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), /changes\.hermesBrowserSettings\?\.newValue\?\.panelResidencyMode/);
});

test('Keep Hermes Web signed in is on by default, sits beside the Hermes Web address, and is saved by Save rather than live', async () => {
  const h = await createSettingsSaveHarness({ settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local' } });
  try {
    assert.equal(h.scope.settings.webappKeepSignedIn, true, 'on unless turned off');
    const toggle = h.document.getElementById('webappKeepSignedInInput');
    assert.equal(toggle?.type, 'checkbox');
    assert.equal(toggle.closest('[data-settings-live]'), null, 'it needs Save');
    assert.equal(toggle.closest('[data-settings-pane]').dataset.settingsPane, h.document.getElementById('hermesWebAddressInput').closest('[data-settings-pane]').dataset.settingsPane,
      'in the same pane as the Hermes Web address field');
    const position = (id) => [...h.document.querySelectorAll('#settingsForm *')].indexOf(h.document.getElementById(id));
    assert.ok(position('webappKeepSignedInField') > position('hermesWebAddressHint'), 'right after the address field and its hint');
    assert.equal(h.document.getElementById('webappKeepSignedInField').querySelector('[data-i18n="webapp.keep_signed_in_label"]')?.tagName, 'STRONG');
    assert.ok(h.document.getElementById('webappKeepSignedInField').querySelector('[data-i18n="webapp.keep_signed_in_hint"]'));
    // Its hint says what it keeps, until when, and what ends it.
    const english = (await import('../extension/lib/locales/en.mjs')).default;
    assert.match(english['webapp.keep_signed_in_hint'], /until you close the browser/);
    assert.match(english['webapp.keep_signed_in_hint'], /hermes webapp --sign-out/);
  } finally {
    h.close();
  }
});

test('Save tells the credential store what the setting now says, after the setting is written', async () => {
  const h = await createSettingsSaveHarness({ settings: { gatewayUrl: 'http://127.0.0.1:8642', connectionMode: 'local' } });
  try {
    h.els.webappKeepSignedInInput.checked = false;
    await h.save();
    assert.equal(h.store.hermesBrowserSettings.webappKeepSignedIn, false);
    assert.equal(h.callsTo('applyWebappCredentialPreference').length, 1, 'off clears what is held and forgets the Webapp dashboard');
  } finally {
    h.close();
  }
});

test('the preference hook clears the held sign-in when off, and tries to keep one right away when on', () => {
  const body = functionSource('applyWebappCredentialPreference');
  assert.match(body, /if \(!keepSignedInEnabled\(settings\)\) \{\s*await webappCredentialStore\(\)\.clear\(\)/);
  assert.match(body, /forgetWebappDashboard\(\)/);
  assert.match(body, /captureWebappCredential\(\{ force: true \}\)/);
});

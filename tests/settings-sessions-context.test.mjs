// Settings > Sessions & Context: the current session's context card sits under
// Browser Behavior, and page context depth and YouTube transcripts are
// three-way choices whose stored values the rest of the extension already reads.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  TRANSCRIPT_MODES,
  providerUrlForVideo,
  transcriptModeFromProvider,
  transcriptProviderFromMode,
} from '../extension/lib/transcript.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('extension/sidepanel.html');
const js = read('extension/sidepanel.js');
const pane = (name) => {
  const start = html.indexOf(`id="settingsPane-${name}"`);
  return html.slice(start, html.indexOf('<section id="settingsPane-', start + 1));
};

test('the context card lives in Sessions & Context, right under Browser Behavior', () => {
  const sessions = pane('sessions');
  assert.match(sessions, /id="settingsContextUsage"/);
  assert.match(sessions, /id="settingsContextSession"/);
  assert.doesNotMatch(pane('permissions'), /context-window-settings/, 'it left the Permissions pane');
  const behaviorEnd = sessions.indexOf('</section>', sessions.indexOf('browser-behavior-settings'));
  const card = sessions.indexOf('context-window-settings');
  assert.ok(behaviorEnd > 0 && card > behaviorEnd, 'the card follows the Browser Behavior card');
  assert.match(js, /if \(settingsActivePane === 'sessions'\) refreshSessionContextTelemetry\(\);/, 'opening the pane asks for a fresh reading');
});

test('depth and transcripts are choice cards inside the Prompt context group', () => {
  const sessions = pane('sessions');
  const group = sessions.slice(sessions.indexOf('settings-control-group'), sessions.indexOf('id="panelResidencyOptions"'));
  for (const value of ['minimal', 'normal', 'full']) assert.match(group, new RegExp(`name="contextDepth" value="${value}"`));
  for (const value of TRANSCRIPT_MODES) assert.match(group, new RegExp(`name="transcriptMode" value="${value}"`));
  assert.match(group, /<label id="transcriptProviderField" class="transcript-provider-field" hidden>/, 'the URL field waits for Custom');
  assert.doesNotMatch(html, /id="contextDepthInput"/, 'the old dropdown is gone');
  assert.doesNotMatch(html, /default, off, or https:/, 'no more typing the mode by hand');
});

test('the stored transcript provider maps to a choice and back without changing what is fetched', () => {
  assert.deepEqual(transcriptModeFromProvider('default'), { mode: 'default', url: '' });
  assert.deepEqual(transcriptModeFromProvider(''), { mode: 'default', url: '' });
  assert.deepEqual(transcriptModeFromProvider('OFF'), { mode: 'off', url: '' });
  const url = 'https://transcripts.example/api?video_id={video_id}';
  assert.deepEqual(transcriptModeFromProvider(url), { mode: 'custom', url });
  assert.deepEqual(transcriptModeFromProvider('ftp://nope'), { mode: 'default', url: '' }, 'the background only fetches http(s)');

  assert.equal(transcriptProviderFromMode('default', url), 'default', 'a URL left in the field is ignored unless Custom is chosen');
  assert.equal(transcriptProviderFromMode('off', url), 'off');
  assert.equal(transcriptProviderFromMode('custom', `  ${url} `), url);
  assert.equal(transcriptProviderFromMode('custom', ''), 'default', 'Custom without an address stays automatic');
  assert.equal(transcriptProviderFromMode('custom', 'not a url'), 'default');
  assert.equal(transcriptProviderFromMode(undefined, ''), 'default');

  // Round trip, and the background still builds the same request.
  for (const stored of ['default', 'off', url]) {
    const { mode, url: field } = transcriptModeFromProvider(stored);
    assert.equal(transcriptProviderFromMode(mode, field), stored);
  }
  assert.equal(providerUrlForVideo(transcriptProviderFromMode('custom', url), 'abc'), 'https://transcripts.example/api?video_id=abc');
});

test('the settings form reads and writes the new choices', () => {
  assert.match(js, /contextDepthInputs: Array\.from\(document\.querySelectorAll\('input\[name="contextDepth"\]'\)\)/);
  assert.match(js, /contextDepth: els\.contextDepthInputs\.find\(\(input\) => input\.checked\)\?\.value/);
  assert.match(js, /syncTranscriptModeControls\(transcriptModeFromProvider\(settings\.transcriptProvider/);
  assert.match(js, /transcriptProvider: transcriptProviderFromMode\(\s*els\.transcriptModeInputs\.find/);
  assert.match(js, /for \(const input of els\.transcriptModeInputs\) input\.addEventListener\('change', renderTranscriptProviderField\);/);
});

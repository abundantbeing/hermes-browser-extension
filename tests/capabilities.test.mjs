import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildContextReceipt,
  capabilityStatusRows,
  connectionSecuritySummary,
  normalizeGatewayCapabilities,
} from '../extension/lib/capabilities.mjs';

test('normalizeGatewayCapabilities maps the Hermes /v1/capabilities API contract', () => {
  const caps = normalizeGatewayCapabilities({
    object: 'hermes.api_server.capabilities',
    platform: 'hermes-agent',
    auth: { type: 'bearer', required: true },
    features: {
      chat_completions: true,
      chat_completions_streaming: true,
      run_submission: true,
      run_events_sse: true,
      session_resources: true,
      session_chat: true,
      session_chat_streaming: true,
      skills_api: true,
      profiles_api: false,
      audio_api: false,
      browser_extension_pairing: false,
      browser_image_upload: false,
    },
    endpoints: {
      health: { method: 'GET', path: '/health' },
      models: { method: 'GET', path: '/v1/models' },
      skills: { method: 'GET', path: '/v1/skills' },
      sessions: { method: 'GET', path: '/api/sessions' },
      runs: { method: 'POST', path: '/v1/runs' },
      run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
      session_chat: { method: 'POST', path: '/api/sessions/{session_id}/chat' },
      session_chat_stream: { method: 'POST', path: '/api/sessions/{session_id}/chat/stream' },
    },
  }, { healthOk: true, hasApiKey: true });

  assert.equal(caps.source, 'api-server');
  assert.equal(caps.health, true);
  assert.equal(caps.auth, true);
  assert.equal(caps.models, true);
  assert.equal(caps.sessions, true);
  assert.equal(caps.sessionChat, true);
  assert.equal(caps.sessionChatStreaming, true);
  assert.equal(caps.skills, true);
  assert.equal(caps.runs, true);
  assert.equal(caps.runEvents, true);
  assert.equal(caps.profiles, false);
  assert.equal(caps.audioTranscription, false);
  assert.equal(caps.browserPairing, false);
  assert.equal(caps.imageUpload, false);
  assert.match(caps.warnings.join('\n'), /audio transcription/i);
});

test('normalizeGatewayCapabilities degrades missing capability routes into a legacy object', () => {
  const caps = normalizeGatewayCapabilities(null, {
    healthOk: true,
    hasApiKey: true,
    warning: 'GET /v1/capabilities failed (404)',
  });

  assert.equal(caps.source, 'legacy');
  assert.equal(caps.health, true);
  assert.equal(caps.auth, true);
  assert.equal(caps.models, true);
  assert.equal(caps.sessions, true);
  assert.equal(caps.sessionChat, true);
  assert.equal(caps.skills, true);
  assert.equal(caps.profiles, false);
  assert.equal(caps.audioTranscription, false);
  assert.equal(caps.browserPairing, false);
  assert.equal(caps.imageUpload, false);
  assert.match(caps.warnings.join('\n'), /legacy/i);
  assert.match(caps.warnings.join('\n'), /404/);
});

test('capabilityStatusRows turn capabilities into compatibility-panel statuses', () => {
  const rows = capabilityStatusRows(normalizeGatewayCapabilities(null, { healthOk: true, hasApiKey: true }), {
    browserSpeechAvailable: true,
  });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));

  assert.equal(byKey.health.status, 'ok');
  assert.equal(byKey.sessions.status, 'ok');
  assert.equal(byKey.profiles.status, 'warn');
  assert.equal(byKey.audioTranscription.status, 'warn');
  assert.match(byKey.audioTranscription.detail, /browser speech fallback/i);
  assert.equal(byKey.imageUpload.status, 'warn');
  assert.equal(byKey.browserPairing.status, 'warn');
});

test('connectionSecuritySummary masks token state and classifies transport', () => {
  const summary = connectionSecuritySummary({
    gatewayMode: 'local-api',
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: 'secret-token-value',
    tokenSource: 'manual',
    lastConnectionTestedAt: 1_700_000_000_000,
  });

  assert.equal(summary.modeLabel, 'Local Hermes API');
  assert.equal(summary.url, 'http://127.0.0.1:8642');
  assert.equal(summary.tokenLabel, 'Manual');
  assert.equal(summary.hasToken, true);
  assert.match(summary.maskedToken, /^•+$/);
  assert.doesNotMatch(summary.maskedToken, /secret|token|value/);
  assert.match(summary.lastTestedLabel, /2023|2024/);
});

test('buildContextReceipt summarizes exactly what browser context was sent', () => {
  const receipt = buildContextReceipt({
    context: {
      activeTab: { title: 'Hermes Docs', url: 'https://hermes-agent.nousresearch.com/docs' },
      tabs: [{ title: 'Hermes Docs', active: true }, { title: 'GitHub', active: false }],
      pageContext: {
        selectedText: 'selected copy',
        text: 'page text '.repeat(100),
        youtubeTranscript: '[0:01] hello world',
      },
    },
    attachments: [
      { kind: 'image', label: 'screen.png', localPath: 'C:/tmp/screen.png' },
      { kind: 'file', label: 'notes.txt', text: 'notes' },
    ],
    settings: {
      includeTabs: true,
      includePageText: true,
      includeSelectedText: true,
    },
  });

  assert.equal(receipt.title, 'What Hermes saw');
  assert.deepEqual(receipt.items.map((item) => item.label), [
    'Active tab',
    'Selected text',
    'Page text',
    'YouTube transcript',
    'Open tabs',
    'Attachments',
    'Redactions',
  ]);
  assert.match(receipt.items.find((item) => item.label === 'Active tab').value, /Hermes Docs/);
  assert.match(receipt.items.find((item) => item.label === 'Attachments').value, /1 image, 1 file/);
});

test('v0.1.6 UI has compatibility, token hygiene, and What Hermes saw surfaces', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const voiceJs = readFileSync(new URL('../extension/voice-dictation.js', import.meta.url), 'utf8');

  assert.match(html, /id="compatibilityList"/);
  assert.match(html, /id="commandMenuButton"/);
  assert.match(html, /id="quickMoreMenu" class="quick-more-menu"/);
  assert.doesNotMatch(html, /class="quick-actions"/);
  assert.doesNotMatch(html, /id="quickActionsScroll"/);
  assert.match(html, /id="connectionSecuritySummary"/);
  assert.match(html, /id="clearTokenButton"/);
  assert.match(html, /version loading/i);
  assert.match(html, /API can use trusted LAN http; dashboard uses https/i);
  assert.doesNotMatch(html, /Hermes on another machine, reached over https/);
  assert.doesNotMatch(html, /v0\.1\.3/);
  assert.match(js, /appendContextReceipt/);
  assert.match(js, /What Hermes saw/);
  assert.match(js, /browserPairing/);
  assert.match(js, /imageUpload/);
  assert.match(voiceJs, /SpeechRecognition|webkitSpeechRecognition/);
  assert.match(voiceJs, /Browser speech fallback/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  VOICE_CAPTURE_MAX_SEGMENT_MS,
  VOICE_CAPTURE_PEAK_THRESHOLD,
  VOICE_CAPTURE_SAMPLE_INTERVAL_MS,
  VOICE_CAPTURE_SILENCE_AFTER_SPEECH_MS,
  VOICE_CAPTURE_SILENT_ESCALATE_MS,
  VOICE_CAPTURE_TIMESLICE_MS,
  joinDictationTranscript,
  voiceCaptureDecision,
  voiceCaptureIsSignal,
  voiceCapturePeak,
  voiceCapturePeakFromBytes,
  voiceDictationCaptureRoute,
  formatVoiceElapsed,
  voiceLevelBarHeights,
} from '../extension/lib/voice-capture.mjs';
import { dashboardModelDiscoveryBaseUrl, resolveDashboardTranscriptionBaseUrl } from '../extension/lib/model-discovery.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Comet local-dashboard side panel takes the MediaRecorder route (verified reporter setup)', () => {
  // Verified from Jon's Comet profile storage (2026-09-10): gatewayMode and
  // connectionTransport are both local-api with the Desktop dashboard
  // WebSocket active, and that transport advertises no audio_transcription
  // REST feature. Comet side panels expose getUserMedia + MediaRecorder, so
  // the ONLY live route is MediaRecorder capture + the local dashboard STT
  // endpoint — never the web-speech fallback that Comet starts with no audio.
  const route = voiceDictationCaptureRoute({
    canRecord: true,
    canUseApiTranscription: false,
    canUseDashboardTranscription: true,
    browserSpeech: true,
  });
  assert.equal(route, 'recorder', 'Comet must select the MediaRecorder capture route, not web speech');

  // The two capability facts that feed that decision, pinned directly.
  assert.equal(
    voiceDictationCaptureRoute({
      canRecord: true,
      canUseApiTranscription: false,
      canUseDashboardTranscription: false,
      browserSpeech: true,
    }),
    'web-speech',
    'without any Hermes transcription route the panel falls back to browser speech when the browser exposes it',
  );
  assert.equal(
    voiceDictationCaptureRoute({ canRecord: true, canUseApiTranscription: false, canUseDashboardTranscription: false, browserSpeech: false }),
    'voice-page',
    'without any live route the panel opens the visible voice dictation page',
  );
  assert.equal(
    voiceDictationCaptureRoute({ canRecord: false, canUseApiTranscription: false, canUseDashboardTranscription: false, browserSpeech: true }),
    'web-speech',
    'panels that cannot record at all still try web speech before the page',
  );
  assert.equal(
    voiceDictationCaptureRoute({ canRecord: true, canUseApiTranscription: true, canUseDashboardTranscription: false, browserSpeech: true }),
    'recorder',
    'an advertised API transcription route also selects the recorder path',
  );
});

test('voice capture monitors and escalates silent microphones; recording continues until stop', () => {
  assert.equal(VOICE_CAPTURE_SILENT_ESCALATE_MS, 6000);
  assert.equal(VOICE_CAPTURE_SAMPLE_INTERVAL_MS, 250);
  assert.ok(VOICE_CAPTURE_PEAK_THRESHOLD > 0 && VOICE_CAPTURE_PEAK_THRESHOLD < 0.1);

  assert.equal(voiceCapturePeak(null), 0);
  assert.equal(voiceCapturePeak(new Float32Array(2048)), 0);
  const loud = new Float32Array(8);
  loud[3] = 0.5;
  loud[5] = -0.72;
  assert.ok(Math.abs(voiceCapturePeak(loud) - 0.72) < 1e-6);
  const dirty = new Float32Array([Number.NaN, 0.25, Number.NaN]);
  assert.ok(Math.abs(voiceCapturePeak(dirty) - 0.25) < 1e-6, 'NaN samples must not poison the peak');
  assert.equal(voiceCapturePeakFromBytes(new Uint8Array(16).fill(128)), 0);
  assert.ok(Math.abs(voiceCapturePeakFromBytes(new Uint8Array([128, 128, 255, 128])) - (127 / 128)) < 1e-6);
  assert.equal(voiceCaptureIsSignal({ peak: 0 }), false);
  assert.equal(voiceCaptureIsSignal({ peak: VOICE_CAPTURE_PEAK_THRESHOLD / 2 }), false);
  assert.equal(voiceCaptureIsSignal({ peak: VOICE_CAPTURE_PEAK_THRESHOLD * 4 }), true);

  assert.equal(
    voiceCaptureDecision({ elapsedMs: VOICE_CAPTURE_SILENT_ESCALATE_MS - 1, everSawSignal: false }),
    'continue',
  );
  assert.equal(
    voiceCaptureDecision({ elapsedMs: VOICE_CAPTURE_SILENT_ESCALATE_MS, everSawSignal: false }),
    'escalate',
    'a microphone that never delivered audio must be converted into a real escalation, not a fake ON state',
  );

  assert.equal(
    voiceCaptureDecision({ elapsedMs: 120000, everSawSignal: true, segmentSawSpeech: true, silenceMs: 60000, segmentMs: 90000 }),
    'continue',
    'after real audio, Desktop-style dictation keeps recording until the user hits stop',
  );
  assert.equal(
    voiceCaptureDecision({ elapsedMs: 5000, everSawSignal: true, segmentSawSpeech: true, silenceMs: 5000, segmentMs: 5000 }),
    'continue',
    'pauses must not kick off a mid-sentence STT round trip',
  );

  assert.equal(joinDictationTranscript('', 'hello'), 'hello');
  assert.equal(joinDictationTranscript('hello', ''), 'hello');
  assert.equal(joinDictationTranscript('hello', 'world'), 'hello world');
  assert.equal(formatVoiceElapsed(0), '0:00');
  assert.equal(formatVoiceElapsed(12), '0:12');
  assert.equal(formatVoiceElapsed(75), '1:15');
  assert.deepEqual(voiceLevelBarHeights(0, { active: false }).length, 5);
  assert.ok(voiceLevelBarHeights(1, { active: true })[2] > voiceLevelBarHeights(0.1, { active: true })[2]);
});

test('dashboard transcription resolves the discovered Desktop dashboard port before the legacy constant', async () => {
  assert.equal(
    await resolveDashboardTranscriptionBaseUrl({ desktopDashboardUrl: 'http://127.0.0.1:39395/' }),
    'http://127.0.0.1:39395',
    'a discovered Desktop dashboard URL wins',
  );
  assert.equal(
    await resolveDashboardTranscriptionBaseUrl({
      desktopDashboardUrl: '',
      gatewayMode: 'local-api',
      discover: async () => 'http://127.0.0.1:41111',
    }),
    'http://127.0.0.1:41111',
    'discovery must run when no URL is known yet',
  );
  assert.equal(
    await resolveDashboardTranscriptionBaseUrl({
      desktopDashboardUrl: '',
      gatewayMode: 'local-api',
      discover: async () => { throw new Error('offline'); },
    }),
    dashboardModelDiscoveryBaseUrl({ gatewayMode: 'local-api' }),
    'a failed discovery must fall back to the legacy constant instead of throwing',
  );
  assert.equal(
    await resolveDashboardTranscriptionBaseUrl({ desktopDashboardUrl: '', gatewayMode: 'local-api', discover: async () => '' }),
    'http://127.0.0.1:9119',
    'an empty discovery falls back to the legacy constant',
  );
  assert.equal(
    await resolveDashboardTranscriptionBaseUrl({ desktopDashboardUrl: '', gatewayMode: 'remote-dashboard', gatewayUrl: 'https://dash.example' }),
    'https://dash.example',
    'remote dashboards keep using the configured gateway URL',
  );
});

test('sidepanel dictation records with a live meter and transcribes on stop', () => {
  const source = read('extension/sidepanel.js');
  const html = read('extension/sidepanel.html');
  const css = read('extension/sidepanel.css');
  assert.match(source, /voiceDictationCaptureRoute/, 'toggleVoiceDictation must route through the shared capture-route contract');
  assert.match(source, /VOICE_CAPTURE_SAMPLE_INTERVAL_MS/, 'the recorder path must sample the microphone level while recording');
  assert.match(source, /voiceCaptureDecision/, 'escalation decisions must come from the shared capture monitor');
  assert.match(source, /renderVoiceActivity\(/, 'the composer must render a Desktop-style dictation meter');
  assert.match(source, /Transcribing/, 'stop must show a transcribing state before inserting text');
  assert.match(html, /id="voiceActivity"/);
  assert.match(css, /\.voice-activity/);
  assert.doesNotMatch(
    source,
    /Click the mic again to transcribe with Hermes speech-to-text/,
    'the second-click-only recorder copy must stay gone',
  );
  assert.doesNotMatch(
    source,
    /text is inserted as you pause/,
    'pause-triggered live STT must not remain as the primary dictation UX',
  );
});

test('sidepanel recorder converts a microphone that never delivers audio into the voice page', () => {
  const source = read('extension/sidepanel.js');
  assert.match(source, /function escalateSilentVoiceCapture\(/, 'silent capture must escalate through a dedicated path');
  assert.match(source, /escalateSilentVoiceCapture\(\)/, 'the capture tick must invoke the escalation');
  assert.match(source, /session\.stopRequested = true/, 'escalation and stop must prevent further segment restarts');
  assert.match(
    source,
    /openVoiceDictationPage\('This side panel microphone produced no audio/,
    'escalation must automatically open the Hermes Voice Dictation tab that posts hermesVoiceDraft back',
  );
});

test('sidepanel and the voice page transcribe through the resolved dashboard port', () => {
  const sidepanel = read('extension/sidepanel.js');
  const voicePage = read('extension/voice-dictation.js');
  for (const source of [sidepanel, voicePage]) {
    assert.match(source, /resolveDashboardTranscriptionBaseUrl/, 'dashboard STT must resolve the discovered Desktop dashboard port');
  }
  assert.match(sidepanel, /desktopDashboardUrl/, 'the sidepanel must feed its discovered dashboard URL into the resolver');
});

test('package check:js syntax-checks the voice capture module', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['check:js'], /node --check extension\/lib\/voice-capture\.mjs/);
});

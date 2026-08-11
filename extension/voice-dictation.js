import {
  AUDIO_TRANSCRIBE_ENDPOINT,
  DEFAULT_SETTINGS,
  buildAudioTranscriptionBody,
  normalizeGatewayUrl,
  prepareOnDeviceSpeechRecognition,
  shouldFallbackToWebSpeechForTranscription,
  shouldUseLocalDashboardAudioTranscription,
} from './lib/common.mjs';
import { initI18n, t, translateUiText } from './lib/i18n.mjs';
import {
  DEFAULT_GATEWAY_CAPABILITIES,
  normalizeGatewayCapabilities,
} from './lib/capabilities.mjs';
import {
  dashboardModelDiscoveryBaseUrl,
  transcribeAudioViaDashboard,
} from './lib/model-discovery.mjs';
import { getBrowserApi } from './lib/browser-api.mjs';
import { browserMicrophoneSettingsUrl, detectBrowserProduct } from './lib/browser-runtime.mjs';

const browserApi = getBrowserApi();
const extensionUrl = browserApi?.runtime?.getURL?.('/') || '';
const browserProduct = detectBrowserProduct({
  userAgent: navigator.userAgent,
  brands: navigator.userAgentData?.brands,
  braveApi: navigator.brave,
  extensionUrl,
});
const startButton = document.getElementById('startVoiceButton');
const settingsButton = document.getElementById('openMicSettingsButton');
const closeButton = document.getElementById('closeVoiceButton');
const statusEl = document.getElementById('voiceStatus');

const VOICE_DRAFT_STORAGE_KEY = 'hermesVoiceDraft';
const VOICE_AUDIO_MIME_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
]);

let settings = { ...DEFAULT_SETTINGS };
let capabilities = { ...DEFAULT_GATEWAY_CAPABILITIES };
let recorder = null;
let stream = null;
let chunks = [];
let recording = false;
let speechRecognition = null;
let speechFinalText = '';
let speechInterimText = '';
let speechActive = false;

function setStatus(message) {
  if (statusEl) statusEl.textContent = translateUiText(message);
}

function setRecording(value, label = '') {
  recording = Boolean(value);
  document.body.classList.toggle('recording', recording);
  if (startButton) startButton.textContent = recording
    ? `${translateUiText('Stop')}${label ? ` ${label}` : ''}`
    : translateUiText('Start dictation');
}

function microphoneSettingsUrl() {
  return browserMicrophoneSettingsUrl({ product: browserProduct, extensionUrl });
}

async function openMicrophoneSettings() {
  const url = microphoneSettingsUrl();
  if (!url) {
    setStatus(t('permissions.state', { state: 'blocked' }));
    return;
  }
  try {
    await browserApi.tabs.create({ url, active: true });
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function preferredVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return VOICE_AUDIO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function speechRecognitionConstructor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function browserSpeechAvailable() {
  return Boolean(speechRecognitionConstructor());
}

function canRecordVoiceAudio() {
  return Boolean(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
}

function canUseHermesStt() {
  return Boolean(settings.apiKey && capabilities.audioTranscription && canRecordVoiceAudio());
}

function canUseLocalDashboardStt() {
  return shouldUseLocalDashboardAudioTranscription({
    gatewayMode: settings.gatewayMode,
    recordingAvailable: canRecordVoiceAudio(),
  });
}

function stopStream() {
  stream?.getTracks?.().forEach((track) => track.stop());
  stream = null;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read voice recording'));
    reader.readAsDataURL(blob);
  });
}

async function loadSettings() {
  const storage = browserApi?.storage?.local;
  if (!storage?.get) return false;
  const stored = await storage.get(['hermesBrowserSettings']);
  settings = { ...DEFAULT_SETTINGS, ...(stored.hermesBrowserSettings || {}) };
  return true;
}

function authHeaders({ json = false } = {}) {
  const headers = json ? { 'Content-Type': 'application/json' } : {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  if (settings.activeProfile) headers['X-Hermes-Profile'] = settings.activeProfile;
  return headers;
}

async function apiFetch(path, options = {}) {
  const base = normalizeGatewayUrl(settings.gatewayUrl);
  const hasBody = typeof options.body !== 'undefined';
  return fetch(`${base}${path}`, {
    ...options,
    redirect: 'error',
    headers: {
      ...authHeaders({ json: hasBody }),
      ...(options.headers || {}),
    },
  });
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function loadCapabilities() {
  if (!settings.apiKey) {
    capabilities = normalizeGatewayCapabilities(null, { healthOk: false, hasApiKey: false, warning: 'No API token stored.' });
    return capabilities;
  }
  try {
    const response = await apiFetch('/v1/capabilities', { method: 'GET', cache: 'no-store' });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(`GET /v1/capabilities failed (${response.status})`);
    capabilities = normalizeGatewayCapabilities(payload, { healthOk: true, hasApiKey: true });
  } catch (error) {
    capabilities = normalizeGatewayCapabilities(null, {
      healthOk: true,
      hasApiKey: Boolean(settings.apiKey),
      warning: error?.message || String(error),
    });
  }
  return capabilities;
}

async function transcribeVoiceRecording(blob) {
  const canUseApiTranscription = canUseHermesStt();
  const canUseDashboardTranscription = canUseLocalDashboardStt();
  if (!canUseApiTranscription && !canUseDashboardTranscription) {
    const error = new Error('Hermes audio transcription is unavailable on this gateway.');
    error.fallbackToWebSpeech = true;
    throw error;
  }
  const dataUrl = await blobToDataUrl(blob);
  if (canUseDashboardTranscription && !canUseApiTranscription) {
    const result = await transcribeAudioViaDashboard({
      baseUrl: dashboardModelDiscoveryBaseUrl({
        gatewayMode: settings.gatewayMode,
        gatewayUrl: settings.gatewayUrl,
      }),
      profile: settings.activeProfile,
      dataUrl,
      mimeType: blob.type || 'audio/webm',
    });
    if (!result.ok) {
      const error = new Error(result.error || 'Hermes Dashboard voice transcription failed.');
      error.status = result.status;
      error.fallbackToWebSpeech = shouldFallbackToWebSpeechForTranscription(result.status);
      throw error;
    }
    return result.transcript;
  }
  const response = await apiFetch(AUDIO_TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(buildAudioTranscriptionBody(dataUrl, blob.type || 'audio/webm')),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(body || `Hermes voice transcription failed (${response.status})`);
    error.status = response.status;
    error.fallbackToWebSpeech = shouldFallbackToWebSpeechForTranscription(response.status);
    throw error;
  }
  const payload = await response.json();
  return String(payload?.transcript || '').trim();
}

async function publishTranscript(transcript, source = 'voice-dictation-page') {
  const payload = {
    type: 'HERMES_VOICE_TRANSCRIPT',
    transcript,
    source,
    ts: Date.now(),
  };
  await browserApi.storage.local.set({ [VOICE_DRAFT_STORAGE_KEY]: payload });
  try {
    await browserApi.runtime.sendMessage(payload);
  } catch {
    // Storage is the durable cross-surface return path; runtime messaging is an immediate optimization.
  }
}

function isMicrophoneBlocked(error) {
  const text = `${error?.name || ''} ${error?.message || error || ''}`.toLowerCase();
  return /notallowed|permission|denied|dismissed|blocked|not-readable|notreadable/.test(text);
}

function ensureBrowserSpeech() {
  if (speechRecognition) return speechRecognition;
  const Recognition = speechRecognitionConstructor();
  if (!Recognition) return null;
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';
  recognition.onresult = (event) => {
    speechInterimText = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index]?.[0]?.transcript || '';
      if (event.results[index]?.isFinal) speechFinalText = `${speechFinalText} ${transcript}`.trim();
      else speechInterimText = `${speechInterimText} ${transcript}`.trim();
    }
    const preview = [speechFinalText, speechInterimText].filter(Boolean).join(' ');
    setStatus(t('voice.browser.preview', { preview: preview || translateUiText('Listening… speak now, then click Stop.') }));
  };
  recognition.onerror = (event) => {
    setStatus(t('voice.browser.stopped', { error: event.error || translateUiText('Speech recognition error') }));
  };
  recognition.onend = async () => {
    const transcript = [speechFinalText, speechInterimText].filter(Boolean).join(' ').trim();
    speechActive = false;
    setRecording(false);
    startButton.disabled = false;
    if (!transcript) {
      setStatus('Voice mode: Browser speech fallback\n\nNo speech detected. Click Start dictation and try again.');
      return;
    }
    await publishTranscript(transcript, 'browser-speech-fallback');
    setStatus(t('voice.transcript_sent', { transcript }));
    setTimeout(() => window.close(), 1600);
  };
  speechRecognition = recognition;
  return speechRecognition;
}

async function startBrowserSpeechFallback() {
  const recognition = ensureBrowserSpeech();
  if (!recognition) {
    setStatus('Voice mode unavailable. This browser does not expose Hermes STT or Web Speech fallback.');
    return false;
  }
  speechFinalText = '';
  speechInterimText = '';
  try {
    startButton.disabled = false;
    const preparation = await prepareOnDeviceSpeechRecognition({
      Recognition: speechRecognitionConstructor(),
      recognition,
      language: recognition.lang,
      onStatus: () => setStatus('Voice mode: On-device speech\n\nDownloading the browser language pack once…'),
    });
    recognition.start();
    speechActive = true;
    setRecording(true, 'speech');
    setStatus(preparation.mode === 'local'
      ? 'Voice mode: On-device speech\n\nListening locally… speak now, then click Stop.'
      : 'Voice mode: Browser speech fallback\n\nListening… speak now, then click Stop.');
    return true;
  } catch (error) {
    speechActive = false;
    setRecording(false);
    setStatus(t('voice.browser.start_failed', { error: error?.message || String(error) }));
    return false;
  }
}

function stopBrowserSpeechFallback() {
  if (!speechActive) return false;
  startButton.disabled = true;
  setStatus('Stopping browser speech fallback…');
  try {
    speechRecognition?.stop?.();
  } catch (error) {
    startButton.disabled = false;
    speechActive = false;
    setRecording(false);
    setStatus(t('voice.browser.stop_failed', { error: error?.message || String(error) }));
  }
  return true;
}

async function startRecording() {
  startButton.disabled = true;
  setStatus('Voice mode: Hermes STT\n\nRequesting microphone access…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    chunks = [];
    const mimeType = preferredVoiceMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data?.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event) => {
      setRecording(false);
      stopStream();
      setStatus(event?.error?.message || 'Voice recording failed.');
    };
    recorder.onstop = async () => {
      const recordingType = recorder?.mimeType || mimeType || 'audio/webm';
      const recordingChunks = chunks;
      recorder = null;
      chunks = [];
      stopStream();
      setRecording(false);
      if (!recordingChunks.length) {
        setStatus('No speech captured. Click Start dictation and try again.');
        return;
      }
      try {
        startButton.disabled = true;
        setStatus('Transcribing through your local Hermes gateway…');
        const transcript = await transcribeVoiceRecording(new Blob(recordingChunks, { type: recordingType }));
        if (!transcript) {
          setStatus('No speech detected. Click Start dictation and try again.');
          return;
        }
        await publishTranscript(transcript, 'hermes-stt');
        setStatus(t('voice.transcript_sent', { transcript }));
        setTimeout(() => window.close(), 1600);
      } catch (error) {
        if (error?.fallbackToWebSpeech && await startBrowserSpeechFallback()) return;
        setStatus(t('voice.transcription_failed', { error: error?.message || String(error) }));
      } finally {
        startButton.disabled = false;
      }
    };
    recorder.start();
    setRecording(true, '+ transcribe');
    setStatus('Voice mode: Hermes STT\n\nRecording… speak now, then click Stop + transcribe.');
  } catch (error) {
    setRecording(false);
    stopStream();
    if (isMicrophoneBlocked(error)) {
      setStatus(t('voice.permission_blocked', { error: error?.message || String(error) }));
    } else if (await startBrowserSpeechFallback()) {
      return;
    } else {
      setStatus(t('voice.start_failed', { error: error?.message || String(error) }));
    }
  } finally {
    startButton.disabled = false;
  }
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') return false;
  startButton.disabled = true;
  setStatus('Stopping recording…');
  recorder.stop();
  return true;
}

async function startBestVoiceMode() {
  await loadCapabilities();
  if (canUseHermesStt() || canUseLocalDashboardStt()) {
    await startRecording();
    return;
  }
  if (await startBrowserSpeechFallback()) return;
  if (!settings.apiKey) {
    setStatus('Voice mode unavailable. Connect Hermes for STT, or use a browser build that supports speech fallback.');
  } else {
    setStatus('Voice mode unavailable. This Hermes runtime has no audio transcription route and this browser exposes no Web Speech fallback.');
  }
}

await initI18n();

startButton?.addEventListener('click', () => {
  if (recording) {
    if (stopRecording()) return;
    if (stopBrowserSpeechFallback()) return;
  } else {
    startBestVoiceMode().catch((error) => setStatus(t('voice.start_failed', { error: error?.message || String(error) })));
  }
});
settingsButton?.addEventListener('click', openMicrophoneSettings);
closeButton?.addEventListener('click', () => window.close());

try {
  const loadedFromExtensionStorage = await loadSettings();
  await loadCapabilities();
  if (!loadedFromExtensionStorage) {
    setStatus('Preview mode: load this page from the installed Hermes Browser Extension to use connected Hermes settings and voice dictation.');
  } else if (canUseHermesStt() || canUseLocalDashboardStt()) {
    setStatus('Voice mode: Hermes STT\n\nAudio is sent once to your local Hermes transcription endpoint when you stop recording.');
  } else if (browserSpeechAvailable()) {
    setStatus('Voice mode: Browser speech fallback\n\nHermes STT is unavailable on this gateway. Speech recognition runs in the browser; only the transcript is sent back to the side panel.');
  } else if (!canRecordVoiceAudio()) {
    startButton.disabled = true;
    setStatus('This browser does not expose MediaRecorder/getUserMedia to extension pages, and Web Speech fallback is unavailable.');
  } else if (!settings.apiKey) {
    setStatus('Hermes is not connected yet. Browser speech fallback is unavailable here; connect the side panel to Hermes, then use voice dictation.');
  }
} catch (error) {
  setStatus(t('voice.settings_load_failed', { error: error?.message || String(error) }));
}

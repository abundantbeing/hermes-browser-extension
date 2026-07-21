import {
  AUDIO_TRANSCRIBE_ENDPOINT,
  DEFAULT_SETTINGS,
  buildAudioTranscriptionBody,
  normalizeGatewayUrl,
  shouldFallbackToWebSpeechForTranscription,
} from './lib/common.mjs';
import {
  DEFAULT_GATEWAY_CAPABILITIES,
  normalizeGatewayCapabilities,
} from './lib/capabilities.mjs';

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
  if (statusEl) statusEl.textContent = message;
}

function setRecording(value, label = '') {
  recording = Boolean(value);
  document.body.classList.toggle('recording', recording);
  if (startButton) startButton.textContent = recording ? `Stop${label ? ` ${label}` : ''}` : 'Start dictation';
}

function chromeRuntimeErrorMessage() {
  try {
    return chrome.runtime?.lastError?.message || '';
  } catch {
    return '';
  }
}

function chromePermissionCall(method, details) {
  return new Promise((resolve, reject) => {
    try {
      method.call(chrome.permissions, details, (value) => {
        const runtimeError = chromeRuntimeErrorMessage();
        if (runtimeError) reject(new Error(runtimeError));
        else resolve(Boolean(value));
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function ensureExtensionAudioPermission() {
  const permissions = globalThis.chrome?.permissions;
  if (!permissions) return true;
  const details = { permissions: ['audioCapture'] };
  if (permissions.request) return chromePermissionCall(permissions.request, details);
  if (permissions.contains) return chromePermissionCall(permissions.contains, details);
  return true;
}

function microphoneSettingsUrl() {
  const site = encodeURIComponent(`chrome-extension://${chrome.runtime.id}/`);
  return `chrome://settings/content/siteDetails?site=${site}`;
}

async function openMicrophoneSettings() {
  const url = microphoneSettingsUrl();
  try {
    await chrome.tabs.create({ url, active: true });
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
  const storage = globalThis.chrome?.storage?.local;
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
  if (!canUseHermesStt()) {
    const error = new Error('Hermes audio transcription is unavailable on this gateway.');
    error.fallbackToWebSpeech = true;
    throw error;
  }
  const dataUrl = await blobToDataUrl(blob);
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
  await chrome.storage.local.set({ [VOICE_DRAFT_STORAGE_KEY]: payload });
  try {
    await chrome.runtime.sendMessage(payload);
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
    setStatus(`Voice mode: Browser speech fallback\n\n${preview || 'Listening… speak now, then click Stop.'}`);
  };
  recognition.onerror = (event) => {
    setStatus(`Browser speech fallback stopped.\n\n${event.error || 'Speech recognition error'}`);
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
    setStatus(`Transcript sent to the Hermes side panel:\n\n${transcript}`);
    setTimeout(() => window.close(), 1600);
  };
  speechRecognition = recognition;
  return speechRecognition;
}

function startBrowserSpeechFallback() {
  const recognition = ensureBrowserSpeech();
  if (!recognition) {
    setStatus('Voice mode unavailable. This browser does not expose Hermes STT or Web Speech fallback.');
    return false;
  }
  speechFinalText = '';
  speechInterimText = '';
  try {
    startButton.disabled = false;
    recognition.start();
    speechActive = true;
    setRecording(true, 'speech');
    setStatus('Voice mode: Browser speech fallback\n\nListening… speak now, then click Stop.');
    return true;
  } catch (error) {
    speechActive = false;
    setRecording(false);
    setStatus(`Browser speech fallback could not start.\n\n${error?.message || String(error)}`);
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
    setStatus(`Browser speech fallback could not stop.\n\n${error?.message || String(error)}`);
  }
  return true;
}

async function startRecording() {
  startButton.disabled = true;
  setStatus('Voice mode: Hermes STT\n\nRequesting microphone access…');
  try {
    const permitted = await ensureExtensionAudioPermission();
    if (!permitted) throw new DOMException('audioCapture permission was not granted', 'NotAllowedError');
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
        setStatus(`Transcript sent to the Hermes side panel:\n\n${transcript}`);
        setTimeout(() => window.close(), 1600);
      } catch (error) {
        if (error?.fallbackToWebSpeech && startBrowserSpeechFallback()) return;
        setStatus(`Voice transcription failed.\n\n${error?.message || String(error)}`);
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
      setStatus(`Microphone permission is blocked for Hermes Browser Extension.\n\nClick Open microphone settings, set Microphone to Allow for this extension, return here, then click Start dictation again.\n\n${error?.message || String(error)}`);
    } else if (startBrowserSpeechFallback()) {
      return;
    } else {
      setStatus(`Could not start voice dictation.\n\n${error?.message || String(error)}`);
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
  if (canUseHermesStt()) {
    await startRecording();
    return;
  }
  if (startBrowserSpeechFallback()) return;
  if (!settings.apiKey) {
    setStatus('Voice mode unavailable. Connect Hermes for STT, or use a Chromium build that supports browser speech fallback.');
  } else {
    setStatus('Voice mode unavailable. This Hermes runtime has no audio transcription route and this browser exposes no Web Speech fallback.');
  }
}

startButton?.addEventListener('click', () => {
  if (recording) {
    if (stopRecording()) return;
    if (stopBrowserSpeechFallback()) return;
  } else {
    startBestVoiceMode().catch((error) => setStatus(`Could not start voice dictation.\n\n${error?.message || String(error)}`));
  }
});
settingsButton?.addEventListener('click', openMicrophoneSettings);
closeButton?.addEventListener('click', () => window.close());

try {
  const loadedFromExtensionStorage = await loadSettings();
  await loadCapabilities();
  if (!loadedFromExtensionStorage) {
    setStatus('Preview mode: load this page from the installed Hermes Browser Extension to use connected Hermes settings and voice dictation.');
  } else if (canUseHermesStt()) {
    setStatus('Voice mode: Hermes STT\n\nAudio is sent once to your configured Hermes transcription endpoint when you stop recording.');
  } else if (browserSpeechAvailable()) {
    setStatus('Voice mode: Browser speech fallback\n\nHermes STT is unavailable on this gateway. Speech recognition runs in the browser; only the transcript is sent back to the side panel.');
  } else if (!canRecordVoiceAudio()) {
    startButton.disabled = true;
    setStatus('This Chromium browser does not expose MediaRecorder/getUserMedia to extension pages, and Web Speech fallback is unavailable.');
  } else if (!settings.apiKey) {
    setStatus('Hermes is not connected yet. Browser speech fallback is unavailable here; connect the side panel to Hermes, then use voice dictation.');
  }
} catch (error) {
  setStatus(`Could not load Hermes Browser settings.\n\n${error?.message || String(error)}`);
}

import {
  AUDIO_TRANSCRIBE_ENDPOINT,
  DEFAULT_SETTINGS,
  buildAudioTranscriptionBody,
  normalizeGatewayUrl,
  shouldFallbackToWebSpeechForTranscription,
} from './lib/common.mjs';

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
let recorder = null;
let stream = null;
let chunks = [];
let recording = false;

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function setRecording(value) {
  recording = Boolean(value);
  document.body.classList.toggle('recording', recording);
  if (startButton) startButton.textContent = recording ? 'Stop + transcribe' : 'Start dictation';
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
    headers: {
      ...authHeaders({ json: hasBody }),
      ...(options.headers || {}),
    },
  });
}

async function transcribeVoiceRecording(blob) {
  if (!settings.apiKey) {
    throw new Error('Hermes is not connected yet. Connect the extension to Hermes, then try dictation again.');
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

async function publishTranscript(transcript) {
  const payload = {
    type: 'HERMES_VOICE_TRANSCRIPT',
    transcript,
    source: 'voice-dictation-page',
    ts: Date.now(),
  };
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (response?.ok) {
      await chrome.storage.local.remove(VOICE_DRAFT_STORAGE_KEY);
      return;
    }
  } catch {
    // Side panel may be closed; fall back to storage for next sidepanel load.
  }
  await chrome.storage.local.set({ [VOICE_DRAFT_STORAGE_KEY]: payload });
}

function isMicrophoneBlocked(error) {
  const text = `${error?.name || ''} ${error?.message || error || ''}`.toLowerCase();
  return /notallowed|permission|denied|dismissed|blocked|not-readable|notreadable/.test(text);
}

async function startRecording() {
  startButton.disabled = true;
  setStatus('Requesting microphone access…');
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
        await publishTranscript(transcript);
        setStatus(`Transcript sent to the Hermes side panel:\n\n${transcript}`);
        setTimeout(() => window.close(), 1600);
      } catch (error) {
        const extra = error?.fallbackToWebSpeech ? '\n\nHermes transcription route is unavailable in this gateway; update Hermes or use browser speech fallback if available.' : '';
        setStatus(`Voice transcription failed.\n\n${error?.message || String(error)}${extra}`);
      } finally {
        startButton.disabled = false;
      }
    };
    recorder.start();
    setRecording(true);
    setStatus('Recording… speak now, then click Stop + transcribe.');
  } catch (error) {
    setRecording(false);
    stopStream();
    if (isMicrophoneBlocked(error)) {
      setStatus(`Microphone permission is blocked for Hermes Browser Extension.\n\nClick Open microphone settings, set Microphone to Allow for this extension, return here, then click Start dictation again.\n\n${error?.message || String(error)}`);
    } else {
      setStatus(`Could not start voice dictation.\n\n${error?.message || String(error)}`);
    }
  } finally {
    startButton.disabled = false;
  }
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') return;
  startButton.disabled = true;
  setStatus('Stopping recording…');
  recorder.stop();
}

startButton?.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});
settingsButton?.addEventListener('click', openMicrophoneSettings);
closeButton?.addEventListener('click', () => window.close());

try {
  const loadedFromExtensionStorage = await loadSettings();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    startButton.disabled = true;
    setStatus('This Chromium browser does not expose MediaRecorder/getUserMedia to extension pages.');
  } else if (!loadedFromExtensionStorage) {
    setStatus('Preview mode: load this page from the installed Hermes Browser Extension to use connected Hermes settings and voice transcription.');
  } else if (!settings.apiKey) {
    setStatus('Hermes is not connected yet. Connect the side panel to Hermes, then use voice dictation.');
  }
} catch (error) {
  setStatus(`Could not load Hermes Browser settings.\n\n${error?.message || String(error)}`);
}

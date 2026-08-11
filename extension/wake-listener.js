import { prepareOnDeviceSpeechRecognition } from './lib/common.mjs';
import { createWakeTranscriptProcessor } from './lib/wake-recognition.mjs';
import {
  DEFAULT_WAKE_WORD_PHRASE,
  WAKE_MESSAGES,
  normalizeWakePhrase,
} from './lib/wake-word.mjs';
import { getBrowserApi } from './lib/browser-api.mjs';

const browserApi = getBrowserApi();
const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
let recognition = null;
let processor = createWakeTranscriptProcessor();
let enabled = false;
let paused = false;
let starting = false;
let restartTimer = null;
let language = 'en-US';
const LOCAL_PREPARE_TIMEOUT_MS = 90_000;

function sendState(state, detail = '', extra = {}) {
  return browserApi.runtime.sendMessage({
    type: WAKE_MESSAGES.localState,
    state,
    detail: String(detail || ''),
    provider: 'browser-local',
    ...extra,
  }).catch(() => null);
}

function clearRestart() {
  if (restartTimer) globalThis.clearTimeout(restartTimer);
  restartTimer = null;
}

function stopRecognition() {
  clearRestart();
  if (!recognition) return;
  try {
    recognition.onend = null;
    recognition.abort();
  } catch {
    // Already stopped.
  }
  recognition = null;
}

function scheduleRestart() {
  clearRestart();
  if (!enabled || paused) return;
  restartTimer = globalThis.setTimeout(() => startRecognition(), 350);
}

async function startRecognition() {
  if (!enabled || paused || starting || recognition) return;
  if (!Recognition) {
    await sendState('unavailable', 'This browser does not expose on-device speech recognition.');
    return;
  }
  starting = true;
  const next = new Recognition();
  next.lang = language;
  next.continuous = true;
  next.interimResults = false;
  next.maxAlternatives = 1;
  let prepareTimer = null;
  const prepared = await Promise.race([
    prepareOnDeviceSpeechRecognition({
      Recognition,
      recognition: next,
      language,
      onStatus: (status) => sendState('arming', status === 'installing' ? 'Installing the local speech language pack…' : status),
    }),
    new Promise((resolve) => {
      prepareTimer = globalThis.setTimeout(() => resolve({ mode: 'cloud', availability: 'timeout' }), LOCAL_PREPARE_TIMEOUT_MS);
    }),
  ]);
  if (prepareTimer) globalThis.clearTimeout(prepareTimer);
  if (prepared.mode !== 'local') {
    starting = false;
    await sendState(
      'unavailable',
      prepared.availability === 'timeout'
        ? 'The local speech language pack did not become ready in 90 seconds. Retry the ear after your browser finishes installing speech support.'
        : prepared.availability === 'unsupported'
        ? 'On-device speech recognition is unavailable in this browser.'
        : 'The local speech language pack is unavailable. Wake listening will not use cloud recognition.',
      { availability: prepared.availability },
    );
    return;
  }

  recognition = next;
  next.onstart = () => sendState('listening', `Listening locally for “${processor.state().phrase}”.`);
  next.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result?.isFinal) continue;
      const transcript = String(result?.[0]?.transcript || '').trim();
      const action = processor.accept(transcript);
      if (action.type === 'wake') {
        sendState('awaiting-command', 'Wake phrase heard. Listening for your command.');
      } else if (action.type === 'command' && action.command) {
        paused = true;
        processor.pause();
        stopRecognition();
        browserApi.runtime.sendMessage({
          type: WAKE_MESSAGES.localDetected,
          text: action.command,
          createdAt: Date.now(),
        }).catch(() => null);
      }
    }
  };
  next.onerror = (event) => {
    const code = String(event?.error || 'speech-recognition-error');
    if (code === 'no-speech' || code === 'aborted') return;
    if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(code)) {
      enabled = false;
      sendState('unavailable', code === 'audio-capture'
        ? 'The microphone is unavailable to the wake listener.'
        : 'Microphone access is blocked for Hermes Browser.');
      return;
    }
    sendState('degraded', `Local wake listener stopped (${code}); retrying.`);
  };
  next.onend = () => {
    recognition = null;
    scheduleRestart();
  };
  try {
    next.start();
  } catch (error) {
    recognition = null;
    await sendState('unavailable', error?.message || String(error));
  } finally {
    starting = false;
  }
}

async function configure(payload = {}) {
  enabled = Boolean(payload.enabled);
  paused = false;
  language = String(payload.language || 'en-US');
  processor = createWakeTranscriptProcessor({ phrase: normalizeWakePhrase(payload.phrase || DEFAULT_WAKE_WORD_PHRASE) });
  stopRecognition();
  if (!enabled) {
    await sendState('off', 'Wake word is off.');
    return { ok: true, state: 'off' };
  }
  await sendState('arming', 'Preparing the on-device wake listener…');
  await startRecognition();
  return { ok: true, state: recognition ? 'listening' : 'unavailable' };
}

async function pause() {
  paused = true;
  processor.pause();
  stopRecognition();
  await sendState('paused', 'Wake listener paused during the voice turn.');
  return { ok: true };
}

async function resume() {
  if (!enabled) return { ok: false, reason: 'disabled' };
  paused = false;
  processor.resume();
  await startRecognition();
  return { ok: true };
}

async function speak(text = '') {
  const cleanText = String(text || '').trim();
  if (!cleanText || !globalThis.speechSynthesis || !globalThis.SpeechSynthesisUtterance) {
    return { ok: false, reason: 'speech-synthesis-unavailable' };
  }
  await pause();
  return new Promise((resolve) => {
    const utterance = new globalThis.SpeechSynthesisUtterance(cleanText);
    let settled = false;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      await resume();
      resolve(result);
    };
    const timeout = globalThis.setTimeout(() => {
      globalThis.speechSynthesis.cancel();
      finish({ ok: false, reason: 'speech-timeout' });
    }, Math.min(120_000, Math.max(15_000, cleanText.length * 90)));
    utterance.onend = () => finish({ ok: true });
    utterance.onerror = (event) => finish({ ok: false, reason: String(event?.error || 'speech-error') });
    globalThis.speechSynthesis.cancel();
    globalThis.speechSynthesis.speak(utterance);
  });
}

browserApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const task = message?.type === WAKE_MESSAGES.configure
    ? configure(message)
    : message?.type === WAKE_MESSAGES.pauseLocal
      ? pause()
      : message?.type === WAKE_MESSAGES.resumeLocal
        ? resume()
        : message?.type === WAKE_MESSAGES.speak
          ? speak(message.text)
          : null;
  if (!task) return false;
  Promise.resolve(task).then(sendResponse).catch((error) => sendResponse({ ok: false, reason: error?.message || String(error) }));
  return true;
});

sendState('ready', 'Wake listener document is ready.');

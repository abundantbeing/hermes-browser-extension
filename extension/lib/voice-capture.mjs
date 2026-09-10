// Shared voice-capture contract for side-panel microphone dictation.
//
// The MediaRecorder path historically only transcribed on a second mic click:
// a user who clicked the mic and talked saw nothing, and the button stayed in
// a fake recording state with no escalation. This module is the deterministic
// decision layer the side panel wires into its capture loop:
//  - escalate a microphone that never delivered ANY audio (silent capture),
//  - rotate a segment once speech has paused so text lands while listening,
//  - pick the capture route (recorder / web speech / visible voice page).
//
// Keep every function pure: the side panel and tests both drive it directly.

export const VOICE_CAPTURE_TIMESLICE_MS = 1000;
export const VOICE_CAPTURE_SAMPLE_INTERVAL_MS = 250;
export const VOICE_CAPTURE_PEAK_THRESHOLD = 0.015;
export const VOICE_CAPTURE_SILENT_ESCALATE_MS = 6000;
export const VOICE_CAPTURE_SILENCE_AFTER_SPEECH_MS = 1200;
export const VOICE_CAPTURE_MAX_SEGMENT_MS = 30000;

export function voiceCapturePeak(samples) {
  if (!samples || typeof samples.length !== 'number') return 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(Number(samples[index]));
    if (Number.isFinite(value) && value > peak) peak = value;
  }
  return peak;
}

export function voiceCapturePeakFromBytes(samples) {
  if (!samples || typeof samples.length !== 'number') return 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs((Number(samples[index] || 0) - 128) / 128);
    if (Number.isFinite(value) && value > peak) peak = value;
  }
  return peak;
}

export function voiceCaptureIsSignal({ peak = 0, threshold = VOICE_CAPTURE_PEAK_THRESHOLD } = {}) {
  return Number(peak) >= Number(threshold);
}

export function voiceCaptureDecision({
  elapsedMs = 0,
  everSawSignal = false,
} = {}) {
  if (!everSawSignal && Number(elapsedMs) >= VOICE_CAPTURE_SILENT_ESCALATE_MS) return 'escalate';
  return 'continue';
}

export function formatVoiceElapsed(seconds = 0) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

export function voiceLevelBarHeights(level = 0, { active = false, weights = [0.5, 0.78, 1, 0.78, 0.5] } = {}) {
  const normalized = Math.max(0, Math.min(Number(level) || 0, 1));
  return weights.map((weight) => (active ? 0.25 + Math.min(0.68, normalized * Number(weight || 0)) : 0.25));
}

export function joinDictationTranscript(previous = '', addition = '') {
  const head = String(previous || '').trim();
  const tail = String(addition || '').trim();
  return [head, tail].filter(Boolean).join(' ');
}

export function voiceDictationCaptureRoute({
  canRecord = false,
  canUseApiTranscription = false,
  canUseDashboardTranscription = false,
  browserSpeech = false,
} = {}) {
  if (!canRecord) return browserSpeech ? 'web-speech' : 'voice-page';
  if (canUseApiTranscription || canUseDashboardTranscription) return 'recorder';
  return browserSpeech ? 'web-speech' : 'voice-page';
}

// GPT-Live voice chat for the side panel.
//
// GPT-Live is a full-duplex OpenAI voice model (gpt-live-1). It listens and
// speaks at the same time over WebRTC and has no tools of its own. When the
// user asks for real work it emits `session.delegation.created`; the panel runs
// that as an ordinary Hermes turn and streams the reply back with
// `session.commentary.append`, which the voice paraphrases aloud. Hermes keeps
// every capability: the selected model, tools, memory and approvals.
//
// The Hermes host creates the session (`POST /api/audio/voice-live/session` on
// the dashboard), so the OpenAI key never reaches the browser; the panel only
// receives a session id and an SDP answer. The profile opts in with
// `voice.voice_chat_mode: gpt-live`. Vendor contract:
// https://developers.openai.com/api/docs/guides/live-delegation
//
// The side panel loads this module on demand; nothing here runs until a live
// session starts. The status probe that decides whether to offer live voice
// lives in model-discovery.mjs, so checking it never loads this module.

import { dashboardAudioJson, VOICE_LIVE_SESSION_PATH } from './model-discovery.mjs';

const CLOSE_TIMEOUT_MS = 15_000;
const ICE_GATHER_TIMEOUT_MS = 10_000;
// Vendor cap: 500 tokens per append. About 4 characters a token, with headroom.
const APPEND_CHAR_LIMIT = 1_400;
// How much of the spoken conversation Hermes receives with each delegation.
const CONTEXT_WINDOW_MS = 5 * 60_000;
const CONTEXT_MAX_FRAGMENTS = 80;
const PROBE_INTERVAL_MS = 100;

// Same wording as tools/voice_live.py VOICE_LIVE_TURN_NOTE. The dashboard socket
// adds it on the gateway (surface "voice-live"); REST turns carry it in the
// per-turn system message.
const VOICE_LIVE_TURN_NOTE = (
  '[Note: this message is a delegation from a live spoken conversation. The text is a voice '
  + 'transcript (it may contain mis-hearings, hesitations and later corrections; use the latest '
  + 'intent). Your reply will be spoken aloud by a voice model that paraphrases it: answer in plain '
  + 'conversational sentences, keep it short (a few sentences unless the user asked for detail), no '
  + 'markdown, no lists, no code blocks, no URLs read out character by character. Do the work with '
  + 'your tools as usual; only the final facts need to be spoken. Do not claim an action succeeded '
  + 'before it actually did.]'
);

export function voiceLiveTurnNote(context = '') {
  const recent = String(context || '').trim();
  return recent ? `${VOICE_LIVE_TURN_NOTE}\n[Recent spoken conversation, newest last:\n${recent}]` : VOICE_LIVE_TURN_NOTE;
}

/** Exchange the panel's SDP offer for the GPT-Live answer through the Hermes host. */
export async function requestVoiceLiveSession({ baseUrl, profile = '', fetchFn, sdp = '', history = [], dashboardToken = '' } = {}) {
  // The vendor needs the offer byte-exact, trailing CRLF included.
  if (!String(sdp || '').trim()) throw new Error('Missing WebRTC offer.');
  const payload = await dashboardAudioJson({
    baseUrl,
    path: VOICE_LIVE_SESSION_PATH,
    profile,
    fetchFn,
    method: 'POST',
    body: { sdp, history },
    timeoutMs: 45_000,
    dashboardToken,
  });
  const answer = payload?.transport?.sdp;
  if (!payload?.ok || !answer) throw new Error('GPT-Live session creation failed.');
  return { sessionId: String(payload.session?.id || ''), answerSdp: String(answer) };
}

/** Split a reply into append-sized chunks on sentence boundaries. */
export function chunkForCommentary(text = '', limit = APPEND_CHAR_LIMIT) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];
  const chunks = [];
  let current = '';
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < sentence.length; index += limit) chunks.push(sentence.slice(index, index + limit));
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Seed a new live session with the chat so far (text turns only, newest kept). */
export function toLiveHistory(turns = [], maxMessages = 24, maxChars = 6_000) {
  const out = [];
  let budget = maxChars;
  for (const turn of [...turns].reverse()) {
    if (turn?.role !== 'user' && turn?.role !== 'assistant') continue;
    const text = String(turn.text || '').replace(/\s+/g, ' ').trim().slice(0, 1_200);
    if (!text) continue;
    if (out.length >= maxMessages || budget - text.length < 0) break;
    budget -= text.length;
    out.unshift({
      type: 'message',
      role: turn.role,
      content: [{ type: turn.role === 'assistant' ? 'output_text' : 'input_text', text }],
    });
  }
  return out;
}

/**
 * The Hermes turn for a delegation: `prompt` is what the user last said (the
 * chat bubble and stored row), `context` the recent spoken exchange, which only
 * rides the model input.
 */
export function delegationPrompt(context = []) {
  const turns = [];
  for (const fragment of context) {
    const last = turns.at(-1);
    if (last && last.speaker === fragment.speaker) last.text += fragment.text;
    else turns.push({ speaker: fragment.speaker, text: String(fragment.text || '') });
  }
  const lastUser = [...turns].reverse().find((turn) => turn.speaker === 'user');
  const prompt = String(lastUser?.text || '').replace(/\s+/g, ' ').trim();
  const transcript = turns
    .map((turn) => `${turn.speaker === 'user' ? 'User' : 'Voice assistant'}: ${turn.text.replace(/\s+/g, ' ').trim()}`)
    .filter((line) => !line.endsWith(': '))
    .join('\n');
  return { prompt: prompt || transcript.slice(-400), context: transcript };
}

// A spoken stop ends the conversation only when the WHOLE utterance is a stop
// phrase, optionally addressed to Hermes, so "stop the docker container" is
// still a request. Same list as the Hermes voice loop.
const STOP_PHRASES = [
  'stop', 'stop listening', 'stop it', 'stop please', 'please stop', 'stop stop',
  'that is all', "that's all", 'never mind', 'nevermind', 'end conversation',
  'end the conversation', 'goodbye', 'good bye', 'bye', 'cancel',
];
const ADDRESS_PREFIXES = ['hey hermes', 'hermes', 'okay', 'ok', 'hey'];

function normalizeUtterance(text = '') {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isVoiceStopCommand(text = '', phrases = STOP_PHRASES) {
  const utterance = normalizeUtterance(text);
  if (!utterance) return false;
  const stops = new Set(phrases.map(normalizeUtterance).filter(Boolean));
  if (stops.has(utterance)) return true;
  return ADDRESS_PREFIXES.some((prefix) => utterance.startsWith(`${prefix} `) && stops.has(utterance.slice(prefix.length + 1).trim()));
}

/** Reply text as it should be spoken: no markdown, code, links or tables. */
export function speakableText(text = '') {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The next piece of a streaming reply to speak. While the reply streams only
 * whole sentences go out; the tail goes out once the turn settles.
 */
export function nextSpeakableChunk(spoken = '', spokenLength = 0, { settled = false } = {}) {
  const text = String(spoken || '');
  const from = Math.max(0, Math.min(Number(spokenLength) || 0, text.length));
  if (settled) return text.length > from ? { chunk: text.slice(from), next: text.length } : { chunk: '', next: from };
  const end = text.length - 2;
  const boundary = Math.max(text.lastIndexOf('. ', end), text.lastIndexOf('! ', end), text.lastIndexOf('? ', end));
  const cut = boundary >= from ? boundary + 1 : from;
  return cut > from ? { chunk: text.slice(from, cut), next: cut } : { chunk: '', next: from };
}

function waitForIceGathering(connection, timers) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = timers.setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', onState);
      // Trickle is fine: the vendor answers with the candidates it has.
      resolve();
    }, ICE_GATHER_TIMEOUT_MS);
    function onState() {
      if (connection.iceGatheringState !== 'complete') return;
      timers.clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', onState);
      resolve();
    }
    connection.addEventListener('icegatheringstatechange', onState);
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed') {
        timers.clearTimeout(timeout);
        reject(new Error('WebRTC connection failed'));
      }
    });
  });
}

function peakLevel(analyser, buffer) {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(buffer);
  let peak = 0;
  for (const sample of buffer) peak = Math.max(peak, Math.abs(sample - 128));
  return peak;
}

export class VoiceLiveSession {
  constructor(handlers = {}, {
    createSession,
    getUserMedia = (constraints) => globalThis.navigator.mediaDevices.getUserMedia(constraints),
    RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
    MediaStreamImpl = globalThis.MediaStream,
    AudioImpl = globalThis.Audio,
    AudioContextImpl = globalThis.AudioContext,
    timers = globalThis,
  } = {}) {
    if (typeof createSession !== 'function') throw new Error('createSession is required');
    this.handlers = handlers;
    this.createSession = createSession;
    this.getUserMedia = getUserMedia;
    this.RTCPeerConnectionImpl = RTCPeerConnectionImpl;
    this.MediaStreamImpl = MediaStreamImpl;
    this.AudioContextImpl = AudioContextImpl;
    this.timers = timers;
    this.audio = AudioImpl ? new AudioImpl() : null;
    if (this.audio) this.audio.autoplay = true;
    this.peer = null;
    this.events = null;
    this.microphone = null;
    this.audioContext = null;
    this.micAnalyser = null;
    this.remoteAnalyser = null;
    this.probe = null;
    this.closeTimer = null;
    this.finalized = false;
    this.started = false;
    this.eventCounter = 0;
    this.transcript = [];
    this.lastSpeaking = false;
    this.quietFrames = 0;
    this.levelValue = 0;
    this.sessionId = '';
    this.activeDelegationId = '';
  }

  get connected() {
    return this.started && this.events?.readyState === 'open';
  }

  /** Voice level 0..1 for the glow and meter: the voice while it speaks, otherwise the mic. */
  level() {
    return this.levelValue;
  }

  analyser() {
    return (this.lastSpeaking ? this.remoteAnalyser : this.micAnalyser) || null;
  }

  nextEventId(prefix) {
    this.eventCounter += 1;
    return `${prefix}_${this.eventCounter}`;
  }

  send(event) {
    if (!this.events || this.events.readyState !== 'open') return false;
    this.events.send(JSON.stringify(event));
    return true;
  }

  /** Recent conversation, oldest first, bounded by time and count. */
  contextWindow() {
    const last = this.transcript.at(-1);
    if (!last) return [];
    const floor = last.endMs - CONTEXT_WINDOW_MS;
    return this.transcript.filter((fragment) => fragment.endMs >= floor).slice(-CONTEXT_MAX_FRAGMENTS);
  }

  async start(history = []) {
    if (this.peer) throw new Error('GPT-Live session already started');
    const connection = new this.RTCPeerConnectionImpl();
    this.peer = connection;
    connection.addEventListener('track', (event) => {
      const stream = this.MediaStreamImpl ? new this.MediaStreamImpl([event.track]) : event.streams?.[0];
      if (this.audio) {
        this.audio.srcObject = stream;
        void this.audio.play?.()?.catch?.(() => undefined);
      }
      this.remoteAnalyser = this.analyserFor(stream);
    });
    connection.addEventListener('connectionstatechange', () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') this.finish('connection_lost', null);
    });

    this.microphone = await this.getUserMedia({ audio: { autoGainControl: true, echoCancellation: true, noiseSuppression: true } });
    if (this.finalized) {
      this.microphone.getTracks().forEach((track) => track.stop());
      throw new Error('GPT-Live session ended before it started');
    }
    for (const track of this.microphone.getAudioTracks()) connection.addTrack(track, this.microphone);
    this.micAnalyser = this.analyserFor(this.microphone);

    // Register the data channel before the offer so its m-line is negotiated.
    const events = connection.createDataChannel('oai-events');
    this.events = events;
    events.addEventListener('message', ({ data }) => this.handleEvent(String(data)));
    events.addEventListener('close', () => {
      if (!this.finalized) this.finish('connection_lost', null);
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIceGathering(connection, this.timers);
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error('Missing local SDP offer');
    const { sessionId, answerSdp } = await this.createSession({ sdp, history });
    if (this.finalized) throw new Error('GPT-Live session ended before it started');
    this.sessionId = sessionId || this.sessionId;
    await connection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    this.armProbe();
  }

  analyserFor(stream) {
    if (!stream || typeof this.AudioContextImpl !== 'function') return null;
    try {
      this.audioContext ||= new this.AudioContextImpl();
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      return analyser;
    } catch {
      // No analyser means no level or speaking hint; the conversation still works.
      return null;
    }
  }

  armProbe() {
    if (this.probe || !this.timers?.setInterval) return;
    const buffer = new Uint8Array(256);
    this.probe = this.timers.setInterval(() => {
      const remote = peakLevel(this.remoteAnalyser, buffer);
      const mic = peakLevel(this.micAnalyser, buffer);
      const loud = remote > 6;
      this.quietFrames = loud ? 0 : this.quietFrames + 1;
      const speaking = loud || (this.lastSpeaking && this.quietFrames < 4);
      this.levelValue = Math.min(1, (speaking ? remote : mic) / 64);
      if (speaking !== this.lastSpeaking) {
        this.lastSpeaking = speaking;
        this.handlers.onSpeakingChange?.(speaking);
      }
    }, PROBE_INTERVAL_MS);
  }

  handleEvent(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    switch (event?.type) {
      case 'session.started':
        this.started = true;
        this.sessionId = event.session?.id || this.sessionId;
        return;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        const fragment = {
          speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
          text: String(event.delta || ''),
          startMs: Number(event.start_ms) || 0,
          endMs: Number(event.end_ms) || 0,
        };
        this.transcript.push(fragment);
        if (this.transcript.length > 2_000) this.transcript.splice(0, this.transcript.length - 1_500);
        this.handlers.onTranscript?.(fragment);
        return;
      }
      case 'session.delegation.created': {
        const id = String(event.delegation?.id || '');
        if (id) {
          this.activeDelegationId = id;
          this.handlers.onDelegation?.(id, this.contextWindow());
        }
        return;
      }
      case 'error': {
        // Late appends after our own close are expected noise.
        if (event.error?.code === 'context_injection_incomplete') return;
        this.handlers.onError?.(String(event.error?.message || 'GPT-Live error'), false);
        return;
      }
      case 'session.closed':
        this.finish(String(event.reason || 'closed'), Number.isFinite(event.usage?.seconds) ? event.usage.seconds : null);
        return;
      default:
    }
  }

  /** Quiet progress for the voice ("Hermes is running the tests"). */
  think(delegationId, content) {
    const text = String(content || '').replace(/\s+/g, ' ').trim().slice(0, APPEND_CHAR_LIMIT);
    if (text) this.send({ type: 'session.thinking.append', delegation_id: delegationId || null, content: text, event_id: this.nextEventId('think') });
  }

  /** A result the voice says aloud, paraphrased. */
  speak(delegationId, content) {
    for (const chunk of chunkForCommentary(content)) {
      this.send({ type: 'session.commentary.append', delegation_id: delegationId || null, content: chunk, event_id: this.nextEventId('say') });
    }
  }

  /** Steer the voice for the rest of the session. */
  instruct(content) {
    const text = String(content || '').trim().slice(0, APPEND_CHAR_LIMIT);
    if (text) this.send({ type: 'session.instructions.append', delegation_id: null, content: text, event_id: this.nextEventId('instr') });
  }

  setMuted(muted) {
    for (const track of this.microphone?.getAudioTracks?.() || []) track.enabled = !muted;
    this.send({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute', event_id: this.nextEventId(muted ? 'mute' : 'unmute') });
  }

  /** Graceful close: ask for `session.closed`, tear down after it or a timeout. */
  close() {
    if (this.finalized) return;
    // Before the session is live there is nothing to close gracefully: tear
    // down now so a start still in flight never applies its answer.
    if (!this.connected || !this.send({ type: 'session.close' })) {
      this.finish('close_requested', null);
      return;
    }
    this.closeTimer = this.timers.setTimeout(() => this.finish('close_requested', null), CLOSE_TIMEOUT_MS);
  }

  finish(reason, usageSeconds) {
    if (this.finalized) return;
    this.finalized = true;
    if (this.closeTimer) this.timers.clearTimeout(this.closeTimer);
    if (this.probe) this.timers.clearInterval(this.probe);
    this.closeTimer = null;
    this.probe = null;
    this.levelValue = 0;
    try { this.micAnalyser?.disconnect?.(); } catch { /* already gone */ }
    try { this.remoteAnalyser?.disconnect?.(); } catch { /* already gone */ }
    void this.audioContext?.close?.()?.catch?.(() => undefined);
    this.microphone?.getTracks?.().forEach((track) => track.stop());
    try { this.events?.close?.(); } catch { /* already closed */ }
    try { this.peer?.close?.(); } catch { /* already closed */ }
    if (this.audio) {
      this.audio.srcObject = null;
      this.audio.pause?.();
    }
    this.handlers.onClosed?.(reason, usageSeconds);
  }
}

// GPT-Live voice chat: the transport module (lib/voice-live.mjs) against fake
// WebRTC and fetch, and the side panel's real controller functions in a VM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as live from '../extension/lib/voice-live.mjs';
import { fetchVoiceLiveStatus, normalizeVoiceLiveStatus, VOICE_LIVE_SESSION_PATH, VOICE_LIVE_STATUS_PATH } from '../extension/lib/model-discovery.mjs';

const root = path.resolve(import.meta.dirname, '..');
const source = readFileSync(path.join(root, 'extension/sidepanel.js'), 'utf8');
const html = readFileSync(path.join(root, 'extension/sidepanel.html'), 'utf8');
const css = readFileSync(path.join(root, 'extension/sidepanel.css'), 'utf8');

const between = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `sidepanel.js still defines ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `sidepanel.js still has ${end} after ${start}`);
  return source.slice(from, to);
};

// ---- fakes -------------------------------------------------------------------

class Emitter {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== fn)); }
  emit(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event); }
}

class FakeChannel extends Emitter {
  constructor(label) { super(); this.label = label; this.readyState = 'open'; this.sent = []; }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 'closed'; }
}

class FakePeer extends Emitter {
  static last = null;
  constructor() {
    super();
    FakePeer.last = this;
    this.tracks = [];
    this.channels = [];
    this.iceGatheringState = 'complete';
    this.connectionState = 'new';
    this.closed = false;
  }
  addTrack(track, stream) { this.tracks.push({ track, stream }); }
  createDataChannel(label) { const channel = new FakeChannel(label); this.channels.push(channel); return channel; }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' }; }
  async setLocalDescription(description) { this.localDescription = description; }
  async setRemoteDescription(description) { this.remoteDescription = description; }
  close() { this.closed = true; }
}

function fakeMicrophone() {
  const track = { kind: 'audio', enabled: true, stopped: false, stop() { this.stopped = true; } };
  return { track, stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
}

class FakeAudio { constructor() { this.srcObject = null; this.paused = true; } play() { this.paused = false; return Promise.resolve(); } pause() { this.paused = true; } }

const quietTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 1,
  clearInterval: () => {},
};

function startableSession(handlers = {}, overrides = {}) {
  const mic = fakeMicrophone();
  const created = [];
  const session = new live.VoiceLiveSession(handlers, {
    createSession: async (body) => { created.push(body); return { sessionId: 'sess_1', answerSdp: 'v=0\r\nanswer\r\n' }; },
    getUserMedia: async () => mic.stream,
    RTCPeerConnectionImpl: FakePeer,
    MediaStreamImpl: class { constructor(tracks) { this.tracks = tracks; } },
    AudioImpl: FakeAudio,
    AudioContextImpl: null,
    timers: quietTimers,
    ...overrides,
  });
  return { session, mic, created };
}

const serverEvent = (channel, event) => channel.emit('message', { data: JSON.stringify(event) });

// ---- transport ---------------------------------------------------------------

test('status: only a profile that selected gpt-live is offered live voice', () => {
  assert.deepEqual(normalizeVoiceLiveStatus({ ok: true, mode: 'gpt-live', available: true, reason: null, model: 'gpt-live-1', voice: 'marin' }),
    { mode: 'gpt-live', available: true, reason: '', model: 'gpt-live-1', voice: 'marin' });
  assert.equal(normalizeVoiceLiveStatus({ ok: true, mode: 'gpt_live', available: false }).mode, 'gpt-live');
  assert.equal(normalizeVoiceLiveStatus({ ok: true, mode: 'chained', available: true }).mode, 'chained');
  assert.equal(normalizeVoiceLiveStatus({ ok: false }), null);
  assert.equal(normalizeVoiceLiveStatus(null), null);
});

function fakeDashboard(routes) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname === '/') return new Response('<script>window.__HERMES_SESSION_TOKEN__ = "tok-123";</script>', { status: 200 });
    const route = routes[parsed.pathname];
    if (!route) return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 });
    const { status = 200, body } = await route(parsed, options);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchFn, calls };
}

test('status and session go through the dashboard with its session token, the key never leaves the host', async () => {
  const dashboard = fakeDashboard({
    [VOICE_LIVE_STATUS_PATH]: () => ({ body: { ok: true, mode: 'gpt-live', available: true, model: 'gpt-live-1', voice: 'cedar' } }),
    [VOICE_LIVE_SESSION_PATH]: (url, options) => ({ body: { ok: true, session: { id: 'sess_9' }, transport: { type: 'webrtc', sdp: `answer for ${JSON.parse(options.body).sdp.length}` } } }),
  });
  const status = await fetchVoiceLiveStatus({ baseUrl: 'http://127.0.0.1:9120/', profile: 'work', fetchFn: dashboard.fetchFn });
  assert.equal(status.mode, 'gpt-live');
  const statusCall = dashboard.calls.find((call) => call.url.includes('/status'));
  assert.equal(new URL(statusCall.url).searchParams.get('profile'), 'work');
  assert.equal(statusCall.options.headers['X-Hermes-Session-Token'], 'tok-123');
  assert.equal(statusCall.options.redirect, 'error', 'a redirect can never carry the session token elsewhere');

  const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  const result = await live.requestVoiceLiveSession({ baseUrl: 'http://127.0.0.1:9120', fetchFn: dashboard.fetchFn, sdp: offer, history: [{ type: 'message' }] });
  assert.deepEqual(result, { sessionId: 'sess_9', answerSdp: `answer for ${offer.length}` });
  const sessionCall = dashboard.calls.find((call) => call.url.endsWith(VOICE_LIVE_SESSION_PATH));
  assert.equal(JSON.parse(sessionCall.options.body).sdp, offer, 'the offer is sent byte-exact, trailing CRLF included');
  assert.equal(sessionCall.options.method, 'POST');
});

test('an older Hermes without the endpoint means no live voice; a host without a key says why', async () => {
  const old = fakeDashboard({});
  assert.equal(await fetchVoiceLiveStatus({ baseUrl: 'http://127.0.0.1:9120', fetchFn: old.fetchFn }), null);
  const noKey = fakeDashboard({
    [VOICE_LIVE_SESSION_PATH]: () => ({ status: 503, body: { detail: 'GPT-Live needs an OpenAI API key (OPENAI_API_KEY or voice.gpt_live.api_key)' } }),
  });
  await assert.rejects(
    live.requestVoiceLiveSession({ baseUrl: 'http://127.0.0.1:9120', fetchFn: noKey.fetchFn, sdp: 'v=0\r\n' }),
    /needs an OpenAI API key/,
  );
});

test('a live session negotiates WebRTC through createSession and relays the vendor events', async () => {
  const seen = { transcript: [], delegations: [], closed: [], errors: [] };
  const { session, mic, created } = startableSession({
    onTranscript: (fragment) => seen.transcript.push(fragment),
    onDelegation: (id, context) => seen.delegations.push({ id, context }),
    onClosed: (reason, seconds) => seen.closed.push({ reason, seconds }),
    onError: (message) => seen.errors.push(message),
  });
  await session.start([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier' }] }]);
  const peer = FakePeer.last;
  const channel = peer.channels[0];
  assert.equal(channel.label, 'oai-events', 'the data channel is negotiated before the offer');
  assert.equal(peer.tracks[0].track, mic.track);
  assert.equal(created[0].sdp, 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n');
  assert.equal(created[0].history[0].content[0].text, 'earlier');
  assert.deepEqual(peer.remoteDescription, { type: 'answer', sdp: 'v=0\r\nanswer\r\n' });

  serverEvent(channel, { type: 'session.started', session: { id: 'sess_1' } });
  assert.equal(session.connected, true);
  serverEvent(channel, { type: 'session.input_transcript.delta', delta: 'What is on ', start_ms: 0, end_ms: 400 });
  serverEvent(channel, { type: 'session.input_transcript.delta', delta: 'this page?', start_ms: 400, end_ms: 900 });
  serverEvent(channel, { type: 'session.delegation.created', delegation: { id: 'dlg_1', type: 'client', target: 'backend' } });
  assert.equal(seen.transcript.length, 2);
  assert.equal(seen.delegations[0].id, 'dlg_1');
  assert.equal(live.delegationPrompt(seen.delegations[0].context).prompt, 'What is on this page?');

  serverEvent(channel, { type: 'error', error: { code: 'context_injection_incomplete', message: 'late' } });
  serverEvent(channel, { type: 'error', error: { message: 'rate limited' } });
  assert.deepEqual(seen.errors, ['rate limited'], 'late appends after close are noise');

  session.speak('dlg_1', 'It is the Hermes docs.');
  session.think('dlg_1', 'Hermes is working: Browser.');
  assert.deepEqual(channel.sent.map((event) => [event.type, event.delegation_id, event.content]), [
    ['session.commentary.append', 'dlg_1', 'It is the Hermes docs.'],
    ['session.thinking.append', 'dlg_1', 'Hermes is working: Browser.'],
  ]);

  session.close();
  assert.equal(channel.sent.at(-1).type, 'session.close');
  serverEvent(channel, { type: 'session.closed', reason: 'closed', usage: { seconds: 42 } });
  assert.deepEqual(seen.closed, [{ reason: 'closed', seconds: 42 }]);
  assert.equal(mic.track.stopped, true, 'the microphone is released');
  assert.equal(peer.closed, true);
});

test('a dropped connection ends the session once and releases the microphone', async () => {
  const closed = [];
  const { session, mic } = startableSession({ onClosed: (reason) => closed.push(reason) });
  await session.start([]);
  FakePeer.last.connectionState = 'failed';
  FakePeer.last.emit('connectionstatechange');
  FakePeer.last.channels[0].emit('close');
  assert.deepEqual(closed, ['connection_lost']);
  assert.equal(mic.track.stopped, true);
});

test('ending before the host answers never leaves a billed session or a live microphone', async () => {
  let release;
  const { session, mic } = startableSession({}, {
    createSession: () => new Promise((resolve) => { release = () => resolve({ sessionId: 's', answerSdp: 'v=0\r\n' }); }),
  });
  const starting = session.start([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  session.close();
  release();
  await assert.rejects(starting, /ended before it started/);
  assert.equal(FakePeer.last.remoteDescription, undefined, 'the answer is never applied');
  assert.equal(mic.track.stopped, true);
});

test('replies are spoken in sentence-sized pieces as they stream, the tail when the turn settles', () => {
  assert.deepEqual(live.nextSpeakableChunk('Hello there. How', 0), { chunk: 'Hello there.', next: 12 });
  assert.deepEqual(live.nextSpeakableChunk('Hello there. How are you? I am', 12), { chunk: ' How are you?', next: 25 });
  assert.deepEqual(live.nextSpeakableChunk('Hello there. How are you? I am', 25), { chunk: '', next: 25 });
  assert.deepEqual(live.nextSpeakableChunk('Hello there. How are you? I am fine.', 25, { settled: true }), { chunk: ' I am fine.', next: 36 });
  assert.equal(live.speakableText('## Result\n- **Two** files in [the repo](https://x.dev)\n```js\nconst a = 1;\n```\nSee https://example.com now.'),
    'Result Two files in the repo See now.');
  const long = Array.from({ length: 60 }, (_, index) => `Sentence number ${index} is here.`).join(' ');
  const chunks = live.chunkForCommentary(long);
  assert.ok(chunks.length > 1 && chunks.every((chunk) => chunk.length <= 1_400));
  assert.equal(chunks.join(' '), long);
});

test('a spoken stop ends the chat only when the whole utterance is a stop phrase', () => {
  for (const said of ['stop', 'Stop!', 'hey Hermes, stop', 'okay goodbye', "That's all.", 'never mind']) assert.equal(live.isVoiceStopCommand(said), true, said);
  for (const said of ['stop the docker container', 'how do I stop a process', '', 'stopwatch']) assert.equal(live.isVoiceStopCommand(said), false, said);
});

test('delegations become a prompt (what the user last said) plus the recent spoken exchange', () => {
  const { prompt, context } = live.delegationPrompt([
    { speaker: 'user', text: 'Book it for ' }, { speaker: 'user', text: 'Friday.' },
    { speaker: 'assistant', text: 'Friday at noon?' },
    { speaker: 'user', text: 'Thursday, not Friday.' },
  ]);
  assert.equal(prompt, 'Thursday, not Friday.');
  assert.equal(context, 'User: Book it for Friday.\nVoice assistant: Friday at noon?\nUser: Thursday, not Friday.');
  assert.match(live.voiceLiveTurnNote(context), /^\[Note: this message is a delegation from a live spoken conversation\./);
  assert.match(live.voiceLiveTurnNote(context), /\[Recent spoken conversation, newest last:\nUser: Book it/);
  const history = live.toLiveHistory([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }, { role: 'system', text: 'x' }]);
  assert.deepEqual(history.map((item) => [item.role, item.content[0].type]), [['user', 'input_text'], ['assistant', 'output_text']]);
});

// ---- side panel ----------------------------------------------------------------

function delegationRunner({ askHermes, sending = false } = {}) {
  const spoken = [];
  const thought = [];
  const session = { speak: (id, text) => spoken.push([id, text]), think: (id, text) => thought.push([id, text]) };
  const state = { phase: 'live', delegationId: '', spokenLength: 0, lastTool: '', session };
  const context = vm.createContext({
    liveVoice: state,
    sending,
    stopped: 0,
    askHermes,
    renderVoiceActivity() {},
    setTimeout,
    Promise,
  });
  context.stopCurrentTurn = async () => { context.stopped += 1; context.sending = false; return true; };
  vm.runInContext(between('async function runLiveVoiceDelegation(', 'function liveVoiceHandlers('), context);
  return { context, state, spoken, thought, run: (id, prompt, voiceContext = '') => context.runLiveVoiceDelegation(state, live, id, prompt, voiceContext) };
}

test('panel: a delegation runs as a Hermes turn and the reply streams back to the voice', async () => {
  let turnOptions = null;
  const runner = delegationRunner({
    askHermes: async (prompt, attachments, options) => {
      turnOptions = { prompt, attachments, options };
      options.onTool({ label: 'Browser' });
      options.onTool({ label: 'Browser' });
      options.onDelta('Hello there. How');
      options.onDelta('Hello there. How are you? I am');
      await options.onComplete('Hello there. How are you? I am fine.');
      return true;
    },
  });
  await runner.run('dlg_1', 'What is on this page?', 'User: What is on this page?');
  assert.equal(turnOptions.prompt, 'What is on this page?');
  assert.equal(turnOptions.options.preserveComposer, true, 'a spoken turn never clears what the user is typing');
  assert.equal(turnOptions.options.disableCommandParsing, true);
  assert.equal(turnOptions.options.voiceLive.context, 'User: What is on this page?');
  assert.match(turnOptions.options.voiceLive.note, /^\[Note: this message is a delegation/);
  assert.deepEqual(runner.spoken, [['dlg_1', 'Hello there.'], ['dlg_1', ' How are you?'], ['dlg_1', ' I am fine.']]);
  assert.deepEqual(runner.thought, [['dlg_1', 'Hermes is working: Browser. Not done yet.']], 'tool progress is quiet, and said once per tool');
  assert.equal(runner.state.delegationId, '');
});

test('panel: a failed turn is apologised for; a turn with nothing to say is reported quietly', async () => {
  const failed = delegationRunner({ askHermes: async () => false });
  await failed.run('dlg_1', 'Open the report');
  assert.deepEqual(failed.spoken, [['dlg_1', 'Sorry, I could not reach Hermes for that request.']]);
  const silent = delegationRunner({ askHermes: async (prompt, attachments, options) => { await options.onComplete('(empty response)'); return true; } });
  await silent.run('dlg_2', 'Archive it');
  assert.deepEqual(silent.spoken, []);
  assert.deepEqual(silent.thought, [['dlg_2', 'Hermes finished that request without a spoken result.']]);
});

test('panel: a newer request stops the running turn, and late words from the old one are never spoken', async () => {
  let finishFirst;
  const calls = [];
  const runner = delegationRunner({
    sending: true,
    askHermes: async (prompt, attachments, options) => {
      calls.push(prompt);
      if (prompt === 'first') return new Promise((resolve) => { finishFirst = async () => { await options.onComplete('Old answer.'); resolve(true); }; });
      await options.onComplete('New answer.');
      return true;
    },
  });
  runner.context.sending = false;
  const first = runner.run('dlg_1', 'first');
  runner.context.sending = true;
  await runner.run('dlg_2', 'second');
  assert.equal(runner.context.stopped, 1, 'the running turn is interrupted first');
  await finishFirst();
  await first;
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(runner.spoken, [['dlg_2', 'New answer.']]);
});

function buttonHarness({ status = null, liveVoice = null, dictating = false, connected = true } = {}) {
  const attributes = new Map();
  const classes = new Set();
  const button = {
    hidden: true,
    disabled: false,
    title: '',
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
    setAttribute: (name, value) => { attributes.set(name, value); },
  };
  const context = vm.createContext({
    els: { liveVoiceButton: button },
    liveVoice,
    dictating,
    voiceTransitionInFlight: false,
    voiceLiveStatus: status && { ...status, scopeKey: 'local|x|' },
    voiceLiveScopeKey: () => 'local|x|',
    isConnected: () => connected,
  });
  vm.runInContext([
    between('function currentVoiceLiveStatus(', 'function refreshVoiceLiveStatus('),
    between('function updateLiveVoiceButtonState(', 'function liveVoiceStatusLabel('),
  ].join('\n'), context);
  context.updateLiveVoiceButtonState();
  return { button, attributes, classes };
}

test('panel: the live voice button appears only for a profile that selected GPT-Live', () => {
  assert.equal(buttonHarness().button.hidden, true, 'unknown status');
  assert.equal(buttonHarness({ status: { mode: 'chained', available: true } }).button.hidden, true, 'chained voice mode');
  assert.equal(buttonHarness({ status: { mode: 'unknown', available: false } }).button.hidden, true, 'older Hermes');

  const ready = buttonHarness({ status: { mode: 'gpt-live', available: true } });
  assert.equal(ready.button.hidden, false);
  assert.equal(ready.button.disabled, false);
  assert.equal(ready.button.title, 'Start live voice chat (GPT-Live)');
  assert.equal(ready.attributes.get('aria-label'), ready.button.title);

  const noKey = buttonHarness({ status: { mode: 'gpt-live', available: false, reason: 'no OpenAI API key (set OPENAI_API_KEY or voice.gpt_live.api_key)' } });
  assert.equal(noKey.button.hidden, false, 'shown, so the profile owner sees why it cannot start');
  assert.equal(noKey.button.disabled, true);
  assert.match(noKey.button.title, /no OpenAI API key/);

  assert.equal(buttonHarness({ status: { mode: 'gpt-live', available: true }, dictating: true }).button.disabled, true, 'one microphone user at a time');
  assert.equal(buttonHarness({ status: { mode: 'gpt-live', available: true }, connected: false }).button.hidden, true, 'hidden while disconnected');

  const on = buttonHarness({ status: { mode: 'gpt-live', available: true }, liveVoice: { phase: 'live' } });
  assert.equal(on.button.title, 'End live voice chat');
  assert.equal(on.attributes.get('aria-pressed'), 'true');
  assert.ok(on.classes.has('active') && on.classes.has('live'));
});

test('panel: REST delegations carry the voice note in the per-turn system message', () => {
  const context = vm.createContext({ currentHermesBrowserSystemPrompt: () => 'BASE' });
  vm.runInContext(between('function turnSystemMessage(', 'function currentSelectedModel('), context);
  assert.equal(context.turnSystemMessage(null), 'BASE');
  assert.equal(context.turnSystemMessage({ context: 'User: hi', note: '[Note: voice]' }), 'BASE\n\n[Note: voice]');
  assert.equal((source.match(/turnSystemMessage\(voiceLive\)/g) || []).length, 4, 'every REST chat body uses it');
  assert.match(source, /const voiceParams = voiceLive \? \{ surface: 'voice-live', voice_context: String\(voiceLive\.context \|\| ''\)\.slice\(0, 6_000\) \} : \{\};/);
  assert.match(between('const submitParams = () => promptSubmitParamsFor(client, {', 'client.request(WS_METHODS.promptSubmit'), /\.\.\.voiceParams,/, 'the dashboard socket marks the turn so the gateway adds the voice note');
});

test('panel: live voice costs nothing until used, and sits with the other voice controls', () => {
  assert.doesNotMatch(source, /from '\.\/lib\/voice-live\.mjs'/, 'no static import');
  assert.match(source, /import\('\.\/lib\/voice-live\.mjs'\)/);
  const probe = between('function refreshVoiceLiveStatus(', 'function scheduleVoiceLiveStatusRefresh(');
  assert.doesNotMatch(probe, /loadVoiceLiveModule/, 'checking whether to offer live voice never loads the voice module');
  assert.match(probe, /VOICE_LIVE_STATUS_TTL_MS/, 'the answer is cached per connection and profile');
  assert.match(between('function scheduleVoiceLiveStatusRefresh(', 'function updateLiveVoiceButtonState('), /if \(voiceLiveStatusTimer\) return;[\s\S]*requestIdleCallback/);
  assert.match(between('function markConnectionProbe(', 'function setStatus('), /updateLiveVoiceButtonState\(\);\s*if \(status === 'connected'\) scheduleVoiceLiveStatusRefresh\(\);/);
  const wake = html.indexOf('id="wakeButton"');
  const liveButton = html.indexOf('id="liveVoiceButton"');
  const mic = html.indexOf('id="voiceButton"');
  assert.ok(wake < liveButton && liveButton < mic, 'between the wake and mic buttons');
  assert.match(html, /<button id="liveVoiceButton"[^>]*\bhidden\b/);
  assert.match(css, /\.composer-live \{ right: 67px; \}/);
  assert.match(css, /\.composer-wake:not\(\[hidden\]\) ~ \.composer-live \{ right: 96px; \}/);
  assert.match(css, /html\[dir="rtl"\] \.composer-live \{ right: auto; left: 67px; \}/);
  assert.match(css, /\.composer-input-wrap\.busy-draft \.composer-live \{ right: 96px; \}/, 'End stays reachable while Stop, Queue and Steer are showing');
  assert.doesNotMatch(css, /\.composer-live\.live\s*\{[^}]*color:/, 'the live state keeps the themed fill/text pair (an icon colour override vanished on light themes)');
  assert.match(source, /addEventListener\('pagehide'[\s\S]{0,200}endLiveVoice\(\{ quiet: true \}\)/, 'closing the panel ends the session');
});

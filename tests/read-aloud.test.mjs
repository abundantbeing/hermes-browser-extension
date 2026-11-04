import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import {
  READ_ALOUD_STATUS,
  chooseReadAloudRoute,
  createBrowserSpeech,
  createGatewayAudioPlayback,
  createReadAloudPlayer,
  dataUrlToBytes,
  describeVoiceRoute,
  readAloudRouteOrder,
  readableTextFromElement,
  splitForSpeech,
} from '../extension/lib/read-aloud.mjs';

function contentFor(html) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="c">${html}</div></body></html>`);
  return document.getElementById('c');
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---- Text extraction ---------------------------------------------------------

test('a reply reads as its prose: code blocks, buttons, pictures and tool or thinking boxes are left out', () => {
  const root = contentFor(`
    <p>Here is the plan.</p>
    <div class="md-code"><button class="md-code-copy" title="Copy">x</button><pre><code>npm run build</code></pre></div>
    <p>Then run <code>npm test</code> and wait.</p>
    <img src="a.png" alt="chart">
    <figure class="generated-image"><img src="b.png" alt="Generated image"></figure>
    <div class="message-tool-activity">Using tool terminal</div>
    <details class="message-reasoning"><summary>Thoughts</summary>I should think.</details>
    <svg aria-hidden="true"><path d="M0 0"/></svg>
  `);
  assert.equal(readableTextFromElement(root), 'Here is the plan.\nThen run npm test and wait.');
});

test('links read as their text, a bare address as its site', () => {
  const root = contentFor('<p>See <a href="https://docs.example.com/a/b?c=1">the guide</a> or <a href="https://github.com/o/r/issues/153">https://github.com/o/r/issues/153</a>.</p>');
  assert.equal(readableTextFromElement(root), 'See the guide or github.com.');
});

test('headings, list items and table rows stand apart so they are not run together', () => {
  const root = contentFor(`
    <h2>Install</h2>
    <ul><li>Download it</li><li>Load it, then pin it.</li></ul>
    <ol><li>First</li><li>Second</li></ol>
    <table><thead><tr><th>Name</th><th>Size</th></tr></thead><tbody><tr><td>one</td><td>2 MB</td></tr></tbody></table>
    <blockquote><p>Quoted words</p></blockquote>
  `);
  assert.equal(readableTextFromElement(root), [
    'Install.',
    'Download it.',
    'Load it, then pin it.',
    'First.',
    'Second.',
    'Name, Size.',
    'one, 2 MB.',
    'Quoted words',
  ].join('\n'));
});

test('hidden nodes and an empty reply read as nothing', () => {
  assert.equal(readableTextFromElement(contentFor('<p aria-hidden="true">hidden</p><span hidden>nope</span>')), '');
  assert.equal(readableTextFromElement(null), '');
  assert.equal(readableTextFromElement(contentFor('<pre><code>only code</code></pre>')), '');
});

test('runs of spaces and blank lines collapse', () => {
  const root = contentFor('<p>a   b c</p>\n\n\n<p>  d  </p>');
  assert.equal(readableTextFromElement(root), 'a b c\nd');
});

// ---- Chunking ----------------------------------------------------------------

test('short text stays one chunk and sentences are packed up to the limit', () => {
  assert.deepEqual(splitForSpeech('Hello there.'), ['Hello there.']);
  assert.deepEqual(splitForSpeech('One. Two. Three.', { maxChars: 9 }), ['One. Two.', 'Three.']);
  assert.deepEqual(splitForSpeech(''), []);
});

test('no chunk passes the limit, however the text is written', () => {
  const longSentence = `${'word '.repeat(120).trim()}.`;
  const chunks = splitForSpeech(longSentence, { maxChars: 100 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 100, `${chunk.length} chars`);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), longSentence);
  const noSpaces = 'x'.repeat(450);
  const hard = splitForSpeech(noSpaces, { maxChars: 200 });
  assert.deepEqual(hard.map((chunk) => chunk.length), [200, 200, 50]);
});

test('a line break always ends a chunk and CJK full stops split sentences', () => {
  assert.deepEqual(splitForSpeech('Title\nBody text here.', { maxChars: 200 }), ['Title', 'Body text here.']);
  assert.deepEqual(splitForSpeech('今日は晴れです。明日は雨です。', { maxChars: 8 }), ['今日は晴れです。', '明日は雨です。']);
});

test('commas are used as the cut for a sentence that is too long', () => {
  const chunks = splitForSpeech('alpha beta gamma, delta epsilon zeta, eta theta iota', { maxChars: 25 });
  assert.deepEqual(chunks, ['alpha beta gamma,', 'delta epsilon zeta,', 'eta theta iota']);
});

// ---- Route choice ------------------------------------------------------------

test('the gateway voice is preferred, then browser speech, then nothing', () => {
  assert.equal(chooseReadAloudRoute({ gatewayAvailable: true, browserAvailable: true }), 'gateway');
  assert.equal(chooseReadAloudRoute({ gatewayAvailable: true, browserAvailable: false }), 'gateway');
  assert.equal(chooseReadAloudRoute({ gatewayAvailable: false, browserAvailable: true }), 'browser');
  assert.equal(chooseReadAloudRoute({ gatewayAvailable: false, browserAvailable: false }), 'none');
  assert.equal(chooseReadAloudRoute(), 'none');
});

test('the order to try puts the gateway first and keeps browser speech as the fallback', () => {
  assert.deepEqual(readAloudRouteOrder({ gatewayAvailable: true, browserAvailable: true }), ['gateway', 'browser']);
  assert.deepEqual(readAloudRouteOrder({ gatewayAvailable: true, browserAvailable: false }), ['gateway']);
  assert.deepEqual(readAloudRouteOrder({ gatewayAvailable: false, browserAvailable: true }), ['browser']);
  assert.deepEqual(readAloudRouteOrder({}), []);
});

test('the Voice row names the active route and the last fallback', () => {
  assert.deepEqual(describeVoiceRoute({ gatewayAvailable: true, browserAvailable: true }), {
    route: 'gateway', stateKey: 'read_aloud.route.gateway', reasonKey: 'read_aloud.reason.gateway', status: 'ok', params: {},
  });
  assert.equal(describeVoiceRoute({ gatewayAvailable: false, browserAvailable: true }).reasonKey, 'read_aloud.reason.browser');
  assert.equal(describeVoiceRoute({ gatewayAvailable: false, browserAvailable: true }).status, 'ok');
  const none = describeVoiceRoute({});
  assert.equal(none.route, 'none');
  assert.equal(none.status, 'warn');
  assert.equal(none.reasonKey, 'read_aloud.reason.none');
  const fellBack = describeVoiceRoute({ gatewayAvailable: true, browserAvailable: true, lastFallback: 'HTTP 400' });
  assert.equal(fellBack.route, 'gateway');
  assert.equal(fellBack.reasonKey, 'read_aloud.reason.gateway_fell_back');
  assert.deepEqual(fellBack.params, { reason: 'HTTP 400' });
});

// ---- Audio bytes ---------------------------------------------------------------

test('a data URL becomes bytes and its type; anything else is refused', () => {
  const result = dataUrlToBytes('data:audio/mpeg;base64,AQID');
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(dataUrlToBytes('data:text/plain;base64,AQID'), null);
  assert.equal(dataUrlToBytes('https://example.com/a.mp3'), null);
  assert.equal(dataUrlToBytes('data:audio/mpeg;base64,'), null);
  assert.equal(dataUrlToBytes(null), null);
});

// ---- Gateway audio playback (Web Audio) --------------------------------------

function fakeAudioContext() {
  const events = [];
  const sources = [];
  class FakeContext {
    constructor() { this.state = 'suspended'; events.push('new'); }
    async resume() { this.state = 'running'; events.push('resume'); }
    async decodeAudioData(buffer) { events.push(`decode:${buffer.byteLength}`); return { duration: 1 }; }
    createBufferSource() {
      const source = {
        connect() {}, onended: null,
        start() { events.push('start'); },
        stop() { events.push('stop'); },
      };
      sources.push(source);
      return source;
    }
    get destination() { return {}; }
    async close() { events.push('close'); }
  }
  return { FakeContext, events, sources };
}

test('gateway audio is decoded and played through Web Audio, and ends when the clip ends', async () => {
  const { FakeContext, events, sources } = fakeAudioContext();
  const playback = createGatewayAudioPlayback({ AudioContextCtor: FakeContext });
  playback.prepare();
  const handle = await playback.play(new Uint8Array([1, 2, 3]));
  assert.deepEqual(events, ['new', 'resume', 'decode:3', 'start']);
  let done = false;
  handle.finished.then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  sources[0].onended();
  await tick();
  assert.equal(done, true);
});

test('stopping gateway audio stops the source and settles the clip', async () => {
  const { FakeContext, events } = fakeAudioContext();
  const playback = createGatewayAudioPlayback({ AudioContextCtor: FakeContext });
  const handle = await playback.play(new Uint8Array([9]));
  handle.stop();
  await handle.finished;
  assert.ok(events.includes('stop'));
});

test('a browser with no Web Audio cannot play gateway audio', async () => {
  const playback = createGatewayAudioPlayback({ AudioContextCtor: null });
  assert.equal(playback.available, false);
  await assert.rejects(() => playback.play(new Uint8Array([1])), /audio/i);
});

// ---- Browser speech ------------------------------------------------------------

function fakeSpeechSynthesis() {
  const spoken = [];
  const synth = {
    spoken,
    cancelled: 0,
    speak(utterance) { spoken.push(utterance); },
    cancel() { synth.cancelled += 1; },
  };
  class Utterance {
    constructor(text) { this.text = text; }
  }
  return { synth, Utterance };
}

test('browser speech reads one chunk at a time, in order, and ends after the last', async () => {
  const { synth, Utterance } = fakeSpeechSynthesis();
  const speech = createBrowserSpeech({ synth, Utterance, lang: 'pt-BR' });
  const handle = speech.speak(['um.', 'dois.']);
  assert.equal(synth.spoken.length, 1);
  assert.equal(synth.spoken[0].text, 'um.');
  assert.equal(synth.spoken[0].lang, 'pt-BR');
  synth.spoken[0].onend();
  assert.equal(synth.spoken.length, 2);
  let done = false;
  handle.finished.then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  synth.spoken[1].onend();
  await handle.finished;
  assert.equal(done, true);
});

test('stopping browser speech cancels the queue and ignores the cancelled chunk\'s end', async () => {
  const { synth, Utterance } = fakeSpeechSynthesis();
  const speech = createBrowserSpeech({ synth, Utterance });
  const handle = speech.speak(['a.', 'b.']);
  handle.stop();
  assert.ok(synth.cancelled >= 1);
  await handle.finished;
  synth.spoken[0].onend?.();
  assert.equal(synth.spoken.length, 1, 'the second chunk is never started');
});

test('a speech error rejects the clip; "canceled" and "interrupted" are not errors', async () => {
  const { synth, Utterance } = fakeSpeechSynthesis();
  const speech = createBrowserSpeech({ synth, Utterance });
  const failing = speech.speak(['a.']);
  synth.spoken[0].onerror({ error: 'synthesis-failed' });
  await assert.rejects(() => failing.finished, /synthesis-failed/);
  const second = speech.speak(['b.']);
  synth.spoken[1].onerror({ error: 'interrupted' });
  await second.finished;
});

test('no speech engine means no browser route', () => {
  const speech = createBrowserSpeech({ synth: null, Utterance: null });
  assert.equal(speech.available, false);
  assert.throws(() => speech.speak(['a.']), /speech/i);
});

// ---- The player ------------------------------------------------------------------

function fakeRoutes() {
  const log = [];
  const synths = [];
  const clips = [];
  const gateway = {
    prepare() { log.push('prepare'); },
    async synthesize(text) {
      const call = deferred();
      synths.push({ text, ...call });
      log.push(`synth:${text}`);
      return call.promise;
    },
    async play(audio) {
      const end = deferred();
      const clip = { audio, end, stopped: false, stop() { clip.stopped = true; end.resolve(); } };
      clips.push(clip);
      log.push(`play:${audio}`);
      return { stop: clip.stop, finished: end.promise };
    },
  };
  const browser = {
    spoken: [],
    speak(chunks) {
      const end = deferred();
      const clip = { chunks, end, stopped: false, stop() { clip.stopped = true; end.resolve(); } };
      browser.spoken.push(clip);
      log.push(`browser:${chunks.join('|')}`);
      return { stop: clip.stop, finished: end.promise };
    },
  };
  return { gateway, browser, log, synths, clips };
}

function makePlayer(overrides = {}) {
  const routes = fakeRoutes();
  const changes = [];
  const player = createReadAloudPlayer({
    gateway: routes.gateway,
    browser: routes.browser,
    onChange: (state) => changes.push(state),
    ...overrides,
  });
  return { player, routes, changes };
}

test('a press starts loading, then speaking when the audio arrives, then idle when it ends', async () => {
  const { player, routes } = makePlayer();
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
  const run = player.toggle('reply-1', 'Hello there.', { order: ['gateway', 'browser'] });
  assert.equal(player.state().status, READ_ALOUD_STATUS.loading);
  assert.equal(player.state().target, 'reply-1');
  await tick();
  routes.synths[0].resolve('audio-a');
  await tick();
  assert.equal(player.state().status, READ_ALOUD_STATUS.speaking);
  assert.equal(player.state().route, 'gateway');
  routes.clips[0].end.resolve();
  await run;
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
  assert.equal(player.state().target, null);
});

test('pressing the reply that is being read stops it', async () => {
  const { player, routes } = makePlayer();
  const first = player.toggle('reply-1', 'Hello there.', { order: ['gateway'] });
  await tick();
  routes.synths[0].resolve('audio-a');
  await tick();
  await player.toggle('reply-1', 'Hello there.', { order: ['gateway'] });
  assert.equal(routes.clips[0].stopped, true);
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
  await first;
});

test('pressing another reply switches: the first stops and the second starts', async () => {
  const { player, routes } = makePlayer();
  const first = player.toggle('reply-1', 'First.', { order: ['gateway'] });
  await tick();
  routes.synths[0].resolve('audio-a');
  await tick();
  const second = player.toggle('reply-2', 'Second.', { order: ['gateway'] });
  assert.equal(routes.clips[0].stopped, true);
  assert.equal(player.state().target, 'reply-2');
  assert.equal(player.state().status, READ_ALOUD_STATUS.loading);
  await first;
  await tick();
  routes.synths[1].resolve('audio-b');
  await tick();
  assert.equal(routes.clips[1].audio, 'audio-b');
  routes.clips[1].end.resolve();
  await second;
});

test('audio that arrives after Stop is thrown away and never played', async () => {
  const { player, routes } = makePlayer();
  const run = player.toggle('reply-1', 'Hello.', { order: ['gateway'] });
  await tick();
  player.stop();
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
  routes.synths[0].resolve('late-audio');
  await run;
  await tick();
  assert.equal(routes.clips.length, 0);
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
});

test('late audio of a stopped reply cannot interrupt the reply that replaced it', async () => {
  const { player, routes } = makePlayer();
  const first = player.toggle('reply-1', 'One.', { order: ['gateway'] });
  await tick();
  const second = player.toggle('reply-2', 'Two.', { order: ['gateway'] });
  await tick();
  routes.synths[1].resolve('audio-two');
  await tick();
  routes.synths[0].resolve('audio-one-late');
  await first;
  await tick();
  assert.deepEqual(routes.clips.map((clip) => clip.audio), ['audio-two']);
  assert.equal(player.state().target, 'reply-2');
  assert.equal(player.state().status, READ_ALOUD_STATUS.speaking);
  routes.clips[0].end.resolve();
  await second;
});

test('a new turn and a chat switch stop what is being read', async () => {
  for (const event of ['turnStarted', 'chatChanged']) {
    const { player, routes } = makePlayer();
    const run = player.toggle('reply-1', 'Hello.', { order: ['gateway'] });
    await tick();
    routes.synths[0].resolve('audio');
    await tick();
    player[event]();
    assert.equal(routes.clips[0].stopped, true, event);
    assert.equal(player.state().status, READ_ALOUD_STATUS.idle, event);
    await run;
  }
});

test('the browser route speaks the short chunks it is given', async () => {
  const { player, routes } = makePlayer();
  const run = player.toggle('reply-1', 'One. Two.', { order: ['browser'], browserChunkChars: 5 });
  await tick();
  assert.deepEqual(routes.browser.spoken[0].chunks, ['One.', 'Two.']);
  assert.equal(player.state().route, 'browser');
  assert.equal(player.state().status, READ_ALOUD_STATUS.speaking);
  routes.browser.spoken[0].end.resolve();
  await run;
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
});

test('when the gateway voice fails the browser speaks instead and the reason is kept', async () => {
  const { player, routes, changes } = makePlayer();
  const run = player.toggle('reply-1', 'Hello.', { order: ['gateway', 'browser'] });
  await tick();
  routes.synths[0].reject(Object.assign(new Error('Speech synthesis failed'), { status: 400 }));
  await tick();
  assert.equal(player.state().route, 'browser');
  assert.equal(player.state().status, READ_ALOUD_STATUS.speaking);
  assert.match(player.state().fallbackReason, /Speech synthesis failed/);
  routes.browser.spoken[0].end.resolve();
  await run;
  assert.ok(changes.some((state) => state.fallbackReason));
});

test('with no route left the press ends with an error and the player is idle', async () => {
  const { player, routes } = makePlayer();
  const run = player.toggle('reply-1', 'Hello.', { order: ['gateway'] });
  await tick();
  routes.synths[0].reject(new Error('nope'));
  const result = await run;
  assert.equal(result.ok, false);
  assert.match(result.error, /nope/);
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
  const none = await player.toggle('reply-2', 'Hello.', { order: [] });
  assert.equal(none.ok, false);
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
});

test('empty text does nothing', async () => {
  const { player } = makePlayer();
  const result = await player.toggle('reply-1', '   ', { order: ['gateway'] });
  assert.equal(result.ok, false);
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
});

test('a long reply is sent to the gateway in pieces and the next piece is fetched while one plays', async () => {
  const { player, routes } = makePlayer();
  const text = ['Alpha one.', 'Beta two.', 'Gamma three.'].join('\n');
  const run = player.toggle('reply-1', text, { order: ['gateway'], gatewayChunkChars: 12 });
  await tick();
  assert.equal(routes.synths.length, 1, 'only the first piece is requested before it is ready');
  routes.synths[0].resolve('a1');
  await tick();
  assert.equal(routes.synths.length, 2, 'the second piece is requested while the first plays');
  assert.equal(routes.clips[0].audio, 'a1');
  routes.synths[1].resolve('a2');
  routes.clips[0].end.resolve();
  await tick();
  assert.equal(routes.clips[1].audio, 'a2');
  assert.equal(routes.synths.length, 3);
  routes.synths[2].resolve('a3');
  routes.clips[1].end.resolve();
  await tick();
  assert.equal(routes.clips[2].audio, 'a3');
  routes.clips[2].end.resolve();
  const result = await run;
  assert.equal(result.ok, true);
  assert.equal(player.state().status, READ_ALOUD_STATUS.idle);
});

test('stopping while a later piece is still being made discards it', async () => {
  const { player, routes } = makePlayer();
  const run = player.toggle('reply-1', 'Alpha one.\nBeta two.', { order: ['gateway'], gatewayChunkChars: 12 });
  await tick();
  routes.synths[0].resolve('a1');
  await tick();
  player.stop();
  routes.synths[1].resolve('a2-late');
  await run;
  await tick();
  assert.deepEqual(routes.clips.map((clip) => clip.audio), ['a1']);
});

test('the player is primed inside the press so the browser allows audio', async () => {
  const { player, routes } = makePlayer();
  const run = player.toggle('reply-1', 'Hello.', { order: ['gateway'] });
  assert.deepEqual(routes.log.slice(0, 1), ['prepare']);
  player.stop();
  await run;
});

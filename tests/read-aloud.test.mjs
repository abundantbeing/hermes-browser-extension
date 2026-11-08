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
  gatewaySpeakUrl,
  ensureReadAloudReplyId,
  preserveReadAloudReplyIds,
  readAloudContentKey,
  readAloudKey,
  readAloudKeysMatch,
  readableTextFromElement,
  requestGatewaySpeech,
  splitForSpeech,
  voiceRouteSummary,
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

test('lines can share a piece when the speech service takes several paragraphs at once', () => {
  assert.deepEqual(splitForSpeech('One.\nTwo.\nThree.', { maxChars: 20, packLines: true }), ['One.\nTwo.\nThree.']);
  assert.deepEqual(splitForSpeech('One.\nTwo.\nThree.', { maxChars: 9, packLines: true }), ['One.\nTwo.', 'Three.']);
  assert.deepEqual(splitForSpeech('One.\nTwo.', { maxChars: 20 }), ['One.', 'Two.']);
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

test('the support report names the route in plain English', () => {
  assert.match(voiceRouteSummary({ gatewayAvailable: true, browserAvailable: true }), /^gateway TTS \(Hermes dashboard \/api\/audio\/speak\)/);
  assert.match(voiceRouteSummary({ gatewayAvailable: true, browserAvailable: true, lastFallback: 'HTTP 400' }), /fell back to browser speech \(HTTP 400\)/);
  assert.match(voiceRouteSummary({ browserAvailable: true }), /^browser speech/);
  assert.match(voiceRouteSummary({}), /^none/);
});

test('a reply keeps its key when the transcript is drawn again, and two replies differ', () => {
  const a = { role: 'assistant', content: 'Hello there', ts: 5, rowId: 9 };
  assert.equal(readAloudKey(a), readAloudKey({ ...a }));
  assert.notEqual(readAloudKey(a), readAloudKey({ ...a, content: 'Hello there!' }));
  assert.equal(readAloudKey(a), readAloudKey({ ...a, ts: 6 }));
  assert.notEqual(readAloudKey(a), readAloudKey({ ...a, rowId: 42 }));

  const prefix = 'A'.repeat(48);
  const first = { role: 'assistant', content: `${prefix} ending one`, ts: 1, rowId: 10 };
  const second = { role: 'assistant', content: `${prefix} ending two`, ts: 2, rowId: 11 };
  assert.equal(first.content.length, second.content.length);
  assert.equal(first.content.slice(0, 48), second.content.slice(0, 48));
  assert.notEqual(readAloudKey(first), readAloudKey(second));
  assert.equal(readAloudKeysMatch(readAloudKey(first), second), false);

  const live = { role: 'assistant', content: 'Finished live reply', ts: 1 };
  const refreshed = { ...live, ts: 99, rowId: 7 };
  assert.notEqual(readAloudKey(live), readAloudKey(refreshed));
  assert.equal(readAloudKeysMatch(readAloudKey(live), refreshed), true);
  assert.equal(readAloudKeysMatch(readAloudKey(refreshed), live), true);

  const looseOne = { role: 'assistant', content: `${prefix} ending one`, ts: 1 };
  const looseTwo = { role: 'assistant', content: `${prefix} ending two`, ts: 2 };
  assert.notEqual(readAloudKey(looseOne), readAloudKey(looseTwo));
  assert.equal(readAloudKeysMatch(readAloudKey(looseOne), looseTwo), false);

  const departure = { role: 'assistant', content: '12:30 is the next departure.', ts: 1, readAloudReplyId: 'dep-1' };
  const departureLiveKey = readAloudKey(departure);
  assert.equal(departureLiveKey, `u:dep-1#${readAloudContentKey(departure)}`);
  assert.equal(readAloudKeysMatch(departureLiveKey, departure), true);
  const departureRefreshed = { ...departure, ts: 99, rowId: 28 };
  assert.equal(readAloudKeysMatch(departureLiveKey, departureRefreshed), true);
  assert.equal(readAloudKeysMatch(readAloudKey(departureRefreshed), departure), true);

  const atMention = { role: 'assistant', content: 'Use @123 for help.', readAloudReplyId: 'at-1' };
  const atMentionKey = readAloudKey(atMention);
  assert.equal(atMentionKey, `u:at-1#${readAloudContentKey(atMention)}`);
  assert.equal(readAloudKeysMatch(atMentionKey, atMention), true);

  const atMentionLive = { role: 'assistant', content: 'Use @123 for help.', ts: 456, readAloudReplyId: 'at-live' };
  const atMentionLiveKey = readAloudKey(atMentionLive);
  assert.equal(atMentionLiveKey, `u:at-live#${readAloudContentKey(atMentionLive)}`);
  assert.equal(readAloudKeysMatch(atMentionLiveKey, atMentionLive), true);
  const atMentionRefreshed = { ...atMentionLive, ts: 999, rowId: 88 };
  assert.equal(readAloudKeysMatch(atMentionLiveKey, atMentionRefreshed), true);

  const bareOne = ensureReadAloudReplyId({ role: 'assistant', content: `${prefix} ending one` });
  const bareTwo = ensureReadAloudReplyId({ role: 'assistant', content: `${prefix} ending two` });
  assert.notEqual(readAloudKey(bareOne), readAloudKey(bareTwo));
  assert.equal(readAloudKeysMatch(readAloudKey(bareOne), bareTwo), false);
});

test('history refresh carries read-aloud reply ids forward when row ids arrive later', () => {
  const live = ensureReadAloudReplyId({ role: 'assistant', content: 'Finished live reply', ts: 1 });
  const localId = live.readAloudReplyId;
  const incoming = [{ role: 'assistant', content: 'Finished live reply', row_id: 7, ts: 99 }];
  const merged = preserveReadAloudReplyIds(incoming, [live]);
  assert.equal(merged[0].readAloudReplyId, localId);
  assert.equal(merged[0].row_id, 7);
  assert.equal(readAloudKeysMatch(readAloudKey(live), { ...merged[0], rowId: 7 }), true);
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

test('a speech request goes to the dashboard with the session token in a header, never in the URL', async () => {
  let seen;
  const result = await requestGatewaySpeech({
    baseUrl: 'http://127.0.0.1:9119/', token: 'tok-1', profile: 'work', text: 'Olá.',
    fetchFn: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, json: async () => ({ ok: true, data_url: 'data:audio/mpeg;base64,AQID', mime_type: 'audio/mpeg', provider: 'edge' }) };
    },
  });
  assert.equal(seen.url, 'http://127.0.0.1:9119/api/audio/speak?profile=work');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['X-Hermes-Session-Token'], 'tok-1');
  assert.deepEqual(JSON.parse(seen.init.body), { text: 'Olá.' });
  assert.ok(!seen.url.includes('tok-1'));
  assert.deepEqual([...result.bytes], [1, 2, 3]);
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.provider, 'edge');
  assert.equal(gatewaySpeakUrl('http://127.0.0.1:9119'), 'http://127.0.0.1:9119/api/audio/speak');
});

test('a refused speech request carries the server words and status; a reply with no audio is an error', async () => {
  await assert.rejects(
    () => requestGatewaySpeech({ baseUrl: 'http://x', token: 't', text: 'a', fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ detail: 'Speech synthesis failed' }) }) }),
    (error) => error.status === 400 && /Speech synthesis failed/.test(error.message),
  );
  await assert.rejects(
    () => requestGatewaySpeech({ baseUrl: 'http://x', token: 't', text: 'a', fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) }),
    /did not return audio/,
  );
  await assert.rejects(() => requestGatewaySpeech({ baseUrl: '', token: 't', text: 'a' }), /not reachable/);
  await assert.rejects(() => requestGatewaySpeech({ baseUrl: 'http://x', token: '', text: 'a' }), /not reachable/);
});

test('stopping playback aborts the request in flight', async () => {
  const controller = new AbortController();
  let aborted = false;
  const request = requestGatewaySpeech({
    baseUrl: 'http://x', token: 't', text: 'a', signal: controller.signal,
    fetchFn: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }),
  });
  controller.abort();
  await assert.rejects(() => request, /aborted/);
  assert.equal(aborted, true);
});

test('stopping before fetch runs never calls fetch when the caller signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalls = 0;
  await assert.rejects(
    () => requestGatewaySpeech({
      baseUrl: 'http://x',
      token: 't',
      text: 'hello',
      signal: controller.signal,
      fetchFn: () => {
        fetchCalls += 1;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      },
    }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(fetchCalls, 0);
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
    async play(audio, { isActive = () => true } = {}) {
      await Promise.resolve();
      await Promise.resolve();
      if (!isActive()) return null;
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

test('two replies with matching length and prefix but different endings switch playback instead of stopping each other', async () => {
  const prefix = 'A'.repeat(48);
  const first = ensureReadAloudReplyId({ role: 'assistant', content: `${prefix} ending one` });
  const second = ensureReadAloudReplyId({ role: 'assistant', content: `${prefix} ending two` });
  const keyOne = readAloudKey(first);
  const keyTwo = readAloudKey(second);
  assert.notEqual(keyOne, keyTwo);
  const ends = [];
  const { browser } = fakeRoutes();
  browser.speak = () => {
    const end = deferred();
    ends.push(end);
    return { stop: () => end.resolve(), finished: end.promise };
  };
  const player = createReadAloudPlayer({ browser, onChange: () => {} });
  const firstRun = player.toggle(keyOne, 'alpha', { order: ['browser'] });
  await tick();
  assert.equal(readAloudKeysMatch(player.state().target, first), true);
  assert.equal(readAloudKeysMatch(player.state().target, second), false);
  const secondRun = player.toggle(keyTwo, 'beta', { order: ['browser'] });
  await tick();
  assert.equal(readAloudKeysMatch(player.state().target, second), true);
  assert.equal(readAloudKeysMatch(player.state().target, first), false);
  ends.forEach((end) => end.resolve());
  await Promise.allSettled([firstRun, secondRun]);
});

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

test('audio decoded after Stop never starts playback', async () => {
  const decode = deferred();
  const { FakeContext, events } = fakeAudioContext();
  const originalDecode = FakeContext.prototype.decodeAudioData;
  FakeContext.prototype.decodeAudioData = function decodePending(buffer) {
    return decode.promise.then(() => originalDecode.call(this, buffer));
  };
  const playback = createGatewayAudioPlayback({ AudioContextCtor: FakeContext });
  const synths = [];
  const player = createReadAloudPlayer({
    gateway: {
      prepare: () => playback.prepare(),
      async synthesize(text) {
        const call = deferred();
        synths.push({ text, ...call });
        return call.promise;
      },
      play: (audio, options) => playback.play(new TextEncoder().encode(String(audio)), options),
    },
    browser: null,
  });
  const run = player.toggle('reply-1', 'Hello.', { order: ['gateway'] });
  await tick();
  synths[0].resolve('audio-a');
  await tick();
  player.stop();
  decode.resolve();
  await run;
  await tick();
  assert.equal(events.includes('start'), false);
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
  assert.equal(player.state().lastFallback, '');
  routes.browser.spoken[0].end.resolve();
  await run;
  assert.equal(player.state().lastFallback, 'Speech synthesis failed');
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

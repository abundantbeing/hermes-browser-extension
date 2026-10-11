import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createVoiceWingbeat } from '../extension/lib/voice-wingbeat.mjs';
import { formatVoiceElapsed, voiceLevelBarHeights } from '../extension/lib/voice-capture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

test('real side-panel renderer adds wingbeat while preserving the label, timer and five volume bars', async () => {
  const dom = new JSDOM('<!doctype html><div id="composerDropZone"><textarea></textarea><button>Mic</button></div><div id="voiceActivity"><strong id="voiceActivityLabel"></strong><span id="voiceActivityTimer"></span><span id="voiceActivityBars"><i></i><i></i><i></i><i></i><i></i></span></div>', { pretendToBeVisual: true });
  const window = dom.window;
  const doc = window.document;
  const host = doc.getElementById('composerDropZone');
  Object.defineProperties(host, { clientWidth: { value: 380 }, clientHeight: { value: 112 } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const gradient = { addColorStop() {} };
  window.HTMLCanvasElement.prototype.getContext = () => ({ setTransform() {}, clearRect() {}, createLinearGradient: () => gradient, createRadialGradient: () => gradient, beginPath() {}, moveTo() {}, bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {}, fill() {}, fillRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {}, ellipse() {} });
  const source = read('extension/sidepanel.js');
  const start = source.indexOf('function renderVoiceActivity()');
  const lazyImport = "import('./lib/voice-wingbeat.mjs')";
  const body = source.slice(start, source.indexOf('\nfunction applyDictationTranscript', start));
  assert.ok(body.includes(lazyImport), 'the panel loads the glow module on demand');
  const context = vm.createContext({
    document: doc,
    els: { composerDropZone: host, voiceActivity: doc.getElementById('voiceActivity'), voiceActivityLabel: doc.getElementById('voiceActivityLabel'), voiceActivityTimer: doc.getElementById('voiceActivityTimer'), voiceActivityBars: doc.getElementById('voiceActivityBars') },
    voiceCaptureSession: { startedAt: Date.now() - 12000, level: 0.35, stopRequested: false },
    voiceWingbeat: null,
    voiceWingbeatLoading: null,
    dictating: true,
    transcribingVoice: false,
    formatVoiceElapsed, voiceLevelBarHeights,
    loadModule: () => Promise.resolve({ createVoiceWingbeat }),
  });
  vm.runInContext(body.replace(lazyImport, 'loadModule()'), context);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const scaleOf = (bar) => Number.parseFloat(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)?.[1]);
  context.renderVoiceActivity();
  assert.equal(doc.getElementById('voiceActivityLabel').textContent, 'Dictating');
  assert.equal(doc.getElementById('voiceActivityTimer').textContent, '0:12');
  assert.equal(doc.querySelectorAll('#voiceActivityBars i').length, 5);
  assert.ok(scaleOf(doc.querySelectorAll('#voiceActivityBars i')[2]) > 0.25, 'the centre bar scales with the voice level');
  await settle();
  assert.equal(host.querySelector('canvas')?.dataset.voiceState, 'recording', 'the glow starts once its module has loaded');
  context.dictating = false;
  context.voiceCaptureSession.stopRequested = true;
  context.transcribingVoice = true;
  context.renderVoiceActivity();
  assert.equal(doc.getElementById('voiceActivityLabel').textContent, 'Transcribing');
  assert.equal(host.querySelector('canvas')?.dataset.voiceState, 'processing');
  assert.equal(host.querySelectorAll('canvas').length, 1);
  context.transcribingVoice = false;
  context.renderVoiceActivity();
  assert.equal(doc.getElementById('voiceActivity').hidden, true);
  assert.equal(host.querySelector('canvas')?.dataset.voiceState, 'idle');
  context.voiceWingbeat?.destroy();
  dom.window.close();
});

test('the four-times-a-second meter tick writes nothing when nothing changed', async () => {
  const dom = new JSDOM('<!doctype html><div id="composerDropZone"></div><div id="voiceActivity"><strong id="voiceActivityLabel"></strong><span id="voiceActivityTimer"></span><span id="voiceActivityBars"><i></i><i></i><i></i><i></i><i></i></span></div>');
  const doc = dom.window.document;
  const source = read('extension/sidepanel.js');
  const start = source.indexOf('function renderVoiceActivity()');
  const body = source.slice(start, source.indexOf('\nfunction applyDictationTranscript', start));
  const glow = { calls: 0, set() { this.calls++; }, prepare() {} };
  const context = vm.createContext({
    document: doc,
    els: { voiceActivity: doc.getElementById('voiceActivity'), voiceActivityLabel: doc.getElementById('voiceActivityLabel'), voiceActivityTimer: doc.getElementById('voiceActivityTimer'), voiceActivityBars: doc.getElementById('voiceActivityBars') },
    voiceCaptureSession: { startedAt: Date.now() - 3200, level: 0.4, stopRequested: false },
    voiceWingbeat: glow,
    voiceWingbeatLoading: null,
    dictating: true,
    transcribingVoice: false,
    formatVoiceElapsed, voiceLevelBarHeights,
  });
  vm.runInContext(body, context);
  context.renderVoiceActivity();
  const records = [];
  const watcher = new dom.window.MutationObserver((list) => records.push(...list));
  watcher.observe(doc.getElementById('voiceActivity'), { attributes: true, childList: true, characterData: true, subtree: true });
  context.renderVoiceActivity();
  context.renderVoiceActivity();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(records.map((record) => `${record.type}:${record.attributeName || record.target.id || ''}`), [], 'an unchanged tick touches no DOM');
  assert.equal(glow.calls, 3, 'the glow still gets every tick (set() is free when unchanged)');
  watcher.disconnect();
  dom.window.close();
});

test('the panel never loads the glow at startup and warms it on the way to the mic', () => {
  const source = read('extension/sidepanel.js');
  assert.doesNotMatch(source, /^import \{[^}]*createVoiceWingbeat[^}]*\} from '\.\/lib\/voice-wingbeat\.mjs';/m, 'no static import on the startup path');
  assert.match(source, /els\.voiceButton\?\.addEventListener\('pointerenter', prewarmVoiceWingbeat/);
  assert.match(source, /els\.voiceButton\?\.addEventListener\('focus', prewarmVoiceWingbeat/);
  assert.match(source, /glow\?\.prepare\?\.\(\)/);
});

test('both shipped voice surfaces load the shared visual module and stylesheet', () => {
  assert.match(read('extension/sidepanel.html'), /href="lib\/voice-wingbeat\.css"/);
  assert.match(read('extension/voice-dictation.html'), /href="lib\/voice-wingbeat\.css"/);
  assert.match(read('extension/voice-dictation.js'), /createVoiceWingbeat/);
  assert.match(read('extension/voice-dictation.js'), /createVoiceLevelSource\(stream\)/);
  assert.match(read('extension/voice-dictation.js'), /voiceLevelSource\?\.close\(\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['check:voice'] || '', /node --check extension\/lib\/voice-wingbeat\.mjs/);
  assert.match(pkg.scripts.verify, /npm run check:voice/);
});

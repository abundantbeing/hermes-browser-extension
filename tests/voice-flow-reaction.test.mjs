import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createVoiceWingbeat } from '../extension/lib/voice-wingbeat.mjs';

test('voice glow reads the live analyser on every animation frame, independently of the 250 ms status meter', () => {
  const dom = new JSDOM('<!doctype html><div id="host"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  const host = window.document.getElementById('host');
  Object.defineProperties(host, { clientWidth: { value: 380 }, clientHeight: { value: 112 } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  let reads = 0;
  let blits = 0;
  let paths = 0;
  const gradient = { addColorStop() {} };
  window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform() {}, clearRect() {}, createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    beginPath() { paths++; }, moveTo() {}, bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {},
    fill() {}, fillRect() {}, save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    drawImage() { blits++; },
  });
  let amplitude = 0.1;
  const analyser = { fftSize: 128, getFloatTimeDomainData(samples) { reads++; samples.fill(amplitude); } };
  const glow = createVoiceWingbeat(host, { level: () => 0, analyser: () => analyser });
  glow.set({ active: true });
  const setupPaths = paths;
  const setupBlits = blits;
  for (const timestamp of [16, 32, 48, 64]) {
    amplitude += 0.04;
    const queued = [...frames.values()]; frames.clear();
    for (const frame of queued) frame(timestamp);
  }
  assert.equal(reads, 4, 'the cached status level is deliberately zero, so each visual frame must read the live analyser');
  assert.ok(blits - setupBlits >= 4 * 10, 'speech is painted from prebuilt sprites');
  assert.equal(paths, setupPaths, 'no shapes are tessellated while recording; sprites are built once');
  glow.set({ active: false });
  for (let step = 0; step < 60 && frames.size; step++) {
    const queued = [...frames.values()]; frames.clear();
    for (const frame of queued) frame(80 + step * 16);
  }
  assert.equal(frames.size, 0);
  glow.destroy();
  dom.window.close();
});

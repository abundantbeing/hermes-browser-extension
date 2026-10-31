import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, meanderGeometry, startupScreenModel, STARTUP_STEP_LINES } from '../extension/lib/startup-screen.mjs';
import { deriveStartupView, initialStartupReadiness, reduceStartupReadiness } from '../extension/lib/readiness.mjs';

const steps = (statuses) => Object.keys(STARTUP_STEP_LINES).map((key, i) => ({
  key,
  label: key === 'gateway' ? 'Gateway transport' : key,
  status: statuses[i] || 'pending',
  detail: '',
}));

test('the Greek key border closes its loop and lights each corner in order', () => {
  for (const [width, height] of [[340, 600], [420, 760], [300, 520]]) {
    const geometry = meanderGeometry(width, height);
    const points = geometry.d.slice(1).split('L').map((pair) => pair.split(',').map(Number));
    const [first, last] = [points[0], points[points.length - 1]];
    assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.2, `${width}x${height} border must close`);
    assert.ok(points.every(([x, y]) => x >= 0 && y >= 0 && x <= width && y <= height), 'border stays inside the panel');
    assert.equal(geometry.cornerFractions.length, 4);
    geometry.cornerFractions.reduce((previous, fraction) => {
      assert.ok(fraction > previous && fraction < 1, 'corners run clockwise from the top left');
      return fraction;
    }, -1);
    assert.ok(geometry.total > 2 * (width + height), 'the key is longer than a plain frame');
  }
});

test('while loading, the screen names the current check with its Greek count', () => {
  const model = startupScreenModel({ visible: true, phase: 'boot', progress: 11, steps: steps(['ready', 'active']) });
  assert.equal(model.tone, 'loading');
  assert.equal(model.count, 'Β · 02 / 09');
  assert.equal(model.state, 'Connecting');
  assert.equal(model.label, 'Gateway transport');
  assert.equal(model.detail, STARTUP_STEP_LINES.gateway, 'a check without its own detail gets its line');
  assert.ok(model.progress > 0.11 && model.progress < 0.2, 'the active check draws part of its unit');
});

test('a check with real detail shows that detail instead of its line', () => {
  const list = steps(['ready', 'ready', 'ready', 'ready', 'active']);
  list[4].detail = 'Using runtime-observed model until the catalog confirms it.';
  const model = startupScreenModel({ visible: true, phase: 'boot', progress: 44, detail: list[4].detail, steps: list });
  assert.equal(model.detail, list[4].detail);
});

test('setup, error and ready read as their own states', () => {
  const setup = startupScreenModel({ visible: true, phase: 'setup-needed', title: 'Connect to Hermes', detail: 'Pair this panel.', progress: 11, steps: steps(['ready', 'unconfigured']) });
  assert.deepEqual([setup.tone, setup.state, setup.label, setup.detail], ['setup', 'Not connected', 'Connect to Hermes', 'Pair this panel.']);
  assert.equal(setup.count, 'Β · 02 / 09', 'setup stops on the gateway check');

  const failing = steps(['ready', 'unreachable']);
  failing[1].detail = 'No response from 127.0.0.1:8642';
  const error = startupScreenModel({ visible: true, phase: 'error', errored: true, detail: 'Connection needs attention. See the status card below.', progress: 11, steps: failing });
  assert.deepEqual([error.tone, error.state, error.count], ['error', 'Needs attention', 'Β · 02 / 09']);
  assert.equal(error.label, 'Gateway transport unreachable');
  assert.equal(error.detail, 'No response from 127.0.0.1:8642');
  assert.equal(error.progress, 0.11, 'an error stops the border where it failed');

  const ready = startupScreenModel({ visible: false, ready: true, phase: 'ready', title: 'Hermes Browser ready', progress: 100, steps: steps(Array(9).fill('ready')) });
  assert.deepEqual([ready.tone, ready.progress, ready.count], ['ready', 1, '09 / 09']);
});

test('the model reads the real readiness view and translates every line', () => {
  let state = initialStartupReadiness({});
  state = reduceStartupReadiness(state, { type: 'step', step: 'settings', status: 'ready' });
  const view = deriveStartupView(state);
  assert.equal(typeof view.errored, 'boolean');
  const model = startupScreenModel(view, (text) => `«${text}»`);
  assert.match(model.state, /^«.+»$/);
  assert.match(model.label, /^«.+»$/);
});

test('pale theme accents are caught before they draw an invisible key', () => {
  assert.equal(contrastRatio('rgb(255, 255, 255)', 'rgb(0, 0, 0)').toFixed(1), '21.0');
  assert.ok(contrastRatio('rgb(201, 193, 255)', 'rgb(255, 255, 255)') < 3, 'Midnight light accent on paper falls back');
  assert.ok(contrastRatio('rgb(139, 183, 255)', 'rgb(10, 53, 114)') >= 3, 'Nous dark accent on navy keeps its colour');
});

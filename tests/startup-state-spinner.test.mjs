import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStateSpinner, startupScreenModel, STARTUP_SPINNER, STARTUP_SPINNER_STILL } from '../extension/lib/startup-screen.mjs';

function fakeLabel() {
  const props = new Map();
  return { props, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
}

function fakeTimers() {
  const live = new Map();
  let next = 1;
  return {
    live,
    setInterval: (fn, ms) => { live.set(next, { fn, ms }); return next++; },
    clearInterval: (id) => live.delete(id),
    tick: () => { for (const { fn } of live.values()) fn(); },
  };
}

test('the state spinner uses the desktop braille glyph frames at its pace', () => {
  assert.deepEqual([...STARTUP_SPINNER.frames], ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
  assert.equal(STARTUP_SPINNER.interval, 80);
  assert.ok(STARTUP_SPINNER.frames.every((frame) => [...frame].length === 1));
});

test('an in-progress state spins and steps through every frame', () => {
  const label = fakeLabel();
  const timers = fakeTimers();
  const spinner = createStateSpinner(label, timers);
  spinner.sync(true);
  assert.equal(spinner.running, true);
  assert.equal(timers.live.size, 1);
  assert.equal([...timers.live.values()][0].ms, 80);
  const seen = [label.props.get('--startup-glyph')];
  for (let i = 1; i < STARTUP_SPINNER.frames.length; i += 1) {
    timers.tick();
    seen.push(label.props.get('--startup-glyph'));
  }
  assert.deepEqual(seen, STARTUP_SPINNER.frames.map((frame) => `"${frame}"`));
  // Rendering again while loading keeps the one timer.
  spinner.sync(true);
  assert.equal(timers.live.size, 1);
});

test('a settled state or a hidden screen stops the timer and clears the glyph', () => {
  const label = fakeLabel();
  const timers = fakeTimers();
  const spinner = createStateSpinner(label, timers);
  spinner.sync(true);
  spinner.sync(false);
  assert.equal(spinner.running, false);
  assert.equal(timers.live.size, 0);
  assert.equal(label.props.has('--startup-glyph'), false);
  spinner.sync(true);
  spinner.stop();
  assert.equal(timers.live.size, 0);
});

test('reduced motion shows a still glyph and never starts a timer', () => {
  const label = fakeLabel();
  const timers = fakeTimers();
  const spinner = createStateSpinner(label, { ...timers, reducedMotion: () => true });
  spinner.sync(true);
  assert.equal(spinner.running, false);
  assert.equal(timers.live.size, 0);
  assert.equal(label.props.get('--startup-glyph'), `"${STARTUP_SPINNER_STILL}"`);
});

test('only the loading tone counts as in progress', () => {
  const step = (status) => [{ key: 'gateway', label: 'Gateway transport', status, detail: '' }];
  assert.equal(startupScreenModel({ visible: true, phase: 'boot', steps: step('active') }).tone, 'loading');
  assert.equal(startupScreenModel({ visible: true, phase: 'setup-needed', steps: step('unconfigured') }).tone, 'setup');
  assert.equal(startupScreenModel({ visible: true, phase: 'error', errored: true, steps: step('failed') }).tone, 'error');
  assert.equal(startupScreenModel({ visible: true, ready: true, steps: step('ready') }).tone, 'ready');
});

test('the screen spins only while visible and loading, and the CSS keeps it still otherwise', () => {
  const screen = readFileSync(new URL('../extension/lib/startup-screen.mjs', import.meta.url), 'utf8');
  assert.match(screen, /const loading = Boolean\(view\?\.visible\) && model\.tone === 'loading';/);
  assert.match(screen, /root\.classList\.toggle\('is-loading', loading\);\s*spinner\.sync\(loading\);/);
  assert.match(screen, /prefers-reduced-motion: reduce/);
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.startup-screen\.is-loading \.startup-state::before\s*\{[^}]*content:\s*var\(--startup-glyph, ""\);[^}]*width:\s*1em;[^}]*line-height:\s*1;/s);
  assert.match(css, /\.startup-screen\.is-loading \.startup-state\s*\{[^}]*animation:\s*startup-state-scan/s);
  assert.doesNotMatch(css, /\.startup-screen\.is-(?:ready|setup|error) \.startup-state::before/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.startup-screen::before,[^@]*?\.startup-screen\.is-loading \.startup-state,\s*\.startup-screen\.is-loading \.startup-state\.startup-swap,[^@]*?animation: none;/);
});

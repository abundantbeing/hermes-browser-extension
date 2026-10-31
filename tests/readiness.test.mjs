import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  deriveStartupView,
  initialStartupReadiness,
  reduceStartupReadiness,
  selectedModelReadiness,
} from '../extension/lib/readiness.mjs';

test('startup reducer keeps the readiness screen visible until hard gates pass', () => {
  let state = initialStartupReadiness({ gatewayMode: 'local-api', gatewayUrl: 'http://127.0.0.1:8642' });
  state = reduceStartupReadiness(state, { step: 'settings', status: 'ready' });
  state = reduceStartupReadiness(state, { step: 'gateway', status: 'ready', gateway: { connected: true, state: 'connected' } });
  state = reduceStartupReadiness(state, { step: 'capabilities', status: 'ready' });
  state = reduceStartupReadiness(state, { step: 'models', status: 'active', detail: 'Loading models…' });

  let view = deriveStartupView(state);
  assert.equal(view.visible, true);
  assert.equal(view.ready, false);
  assert.match(view.detail, /Loading models/i);

  state = reduceStartupReadiness(state, { step: 'models', status: 'ready' });
  state = reduceStartupReadiness(state, { step: 'selectedModel', status: 'ready' });
  state = reduceStartupReadiness(state, { step: 'skills', status: 'skipped' });
  state = reduceStartupReadiness(state, { step: 'profiles', status: 'skipped' });
  state = reduceStartupReadiness(state, { step: 'sessions', status: 'ready' });
  state = reduceStartupReadiness(state, { step: 'sessionBinding', status: 'ready' });
  view = deriveStartupView(state);

  assert.equal(state.ready, true);
  assert.equal(view.visible, false);
  assert.equal(view.progress, 100);
});

test('startup reducer classifies unconfigured and unreachable gateways as setup/error states', () => {
  const setup = reduceStartupReadiness(initialStartupReadiness(), {
    step: 'gateway',
    status: 'unconfigured',
    detail: 'Add a Hermes API token.',
  });
  assert.equal(setup.phase, 'setup-needed');
  assert.equal(deriveStartupView(setup).title, 'Connect to Hermes');

  const unreachable = reduceStartupReadiness(initialStartupReadiness(), {
    step: 'gateway',
    status: 'unreachable',
    detail: 'http://127.0.0.1:8642 is not responding.',
  });
  assert.equal(unreachable.phase, 'error');
  assert.equal(deriveStartupView(unreachable).title, 'Hermes needs attention');
});

test('blocked cascade events never clobber the setup-needed phase after an unconfigured gateway', () => {
  let state = initialStartupReadiness();
  state = reduceStartupReadiness(state, {
    type: 'stage',
    phase: 'gateway',
    step: 'gateway',
    status: 'unconfigured',
    detail: 'Add a Hermes API token or complete pairing to use the Hermes Browser Extension fully.',
    blockingError: 'gateway: Add a Hermes API token or complete pairing to use the Hermes Browser Extension fully.',
  });
  assert.equal(state.phase, 'setup-needed');
  for (const stage of ['capabilities', 'models', 'selectedModel', 'skills', 'profiles', 'sessions', 'sessionBinding']) {
    state = reduceStartupReadiness(state, {
      type: 'stage',
      phase: stage,
      step: stage,
      status: 'blocked',
      detail: `Blocked by gateway failure.`,
    });
  }
  assert.equal(state.phase, 'setup-needed');
  const view = deriveStartupView(state);
  assert.equal(view.title, 'Connect to Hermes');
  assert.equal(view.detail, 'Add a Hermes API token or complete pairing to use the Hermes Browser Extension fully.');
});

test('missing capabilities and sparse model data degrade without blocking ready state', () => {
  let state = initialStartupReadiness();
  for (const [step, status] of [
    ['settings', 'ready'],
    ['gateway', 'ready'],
    ['capabilities', 'legacy'],
    ['models', 'fallback'],
    ['selectedModel', 'observed'],
    ['skills', 'skipped'],
    ['profiles', 'skipped'],
    ['sessions', 'fallback'],
    ['sessionBinding', 'ready'],
  ]) {
    state = reduceStartupReadiness(state, { step, status });
  }
  assert.equal(state.ready, true);
  assert.equal(deriveStartupView(state).visible, false);
});

test('selectedModelReadiness distinguishes requestable, observed, and missing models', () => {
  assert.equal(selectedModelReadiness({
    settings: { model: 'openai/gpt-5.5' },
    availableModels: [{ id: 'openai/gpt-5.5', rawModelId: 'gpt-5.5', runtimeSelectable: true }],
  }).status, 'ready');

  assert.equal(selectedModelReadiness({
    settings: { model: 'history-only' },
    availableModels: [{ id: 'history-only', runtimeSelectable: false }],
  }).status, 'observed');

  assert.equal(selectedModelReadiness({
    settings: { model: 'missing-model' },
    availableModels: [],
    activeSessionRuntime: { provider: 'openrouter', model: 'observed-runtime' },
  }).status, 'observed');

  assert.equal(selectedModelReadiness({ settings: { model: 'missing-model' }, availableModels: [] }).status, 'error');
});

test('sidepanel includes startup readiness UI, styles, and boot controller wiring', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

  assert.match(html, /id="startupScreen"/);
  assert.match(html, /id="startupStepList"/);
  assert.match(css, /startup-screen/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(js, /runStartupReadiness/);
  assert.match(js, /deriveStartupView/);
});

test('sidepanel startup and conversation chrome use the compact branded shell', () => {
  const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

  assert.match(html, /assets\/img\/hermes-browser-logo-left\.svg/);
  assert.match(html, /class="startup-brand-icon"/);
  assert.match(css, /\.startup-brand-icon\s*\{[^}]*assets\/img\/hermes-extension-icon-outline\.png/s);
  assert.match(css, /html\[data-hermes-mode="light"\] \.startup-brand-icon\s*\{[^}]*assets\/img\/hermes-extension-icon-solid\.png/s);
  assert.ok(existsSync(new URL('../extension/assets/img/hermes-extension-icon-outline.png', import.meta.url)));
  assert.ok(existsSync(new URL('../extension/assets/img/hermes-extension-icon-solid.png', import.meta.url)));
  assert.match(css, /\.startup-screen\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*place-items:\s*center;[^}]*overflow:\s*hidden;/s);
  assert.match(html, /id="startupActions"/);
  assert.match(css, /body\.startup-active\s+\.topbar\s*\{[^}]*display:\s*none;/s);
  assert.doesNotMatch(css, /--startup-settings-top/);
  assert.match(js, /function\s+positionStartupSettings[\s\S]*startupActions/);
  assert.match(css, /body\.startup-active\s+\.startup-actions\s+#settingsButton\s*\{[^}]*pointer-events:\s*auto;/s);
  assert.match(css, /\.startup-brand-lockup\s*\{[^}]*justify-items:\s*center;/s);
  assert.doesNotMatch(html, /Connecting Browser Extension/i);
  assert.match(css, /\.startup-brand-icon\s*\{[^}]*width:\s*190px;/s);
  // The logo resolves once per showing: scanlines, then a coarse-to-fine
  // ordered dither, held frame by frame; reduced motion shows it at once.
  assert.match(css, /\.startup-screen:not\(\[hidden\]\) \.startup-brand-icon\s*\{[^}]*animation:\s*startup-logo-resolve 1s step-end 0\.2s both;/s);
  assert.match(css, /@keyframes startup-logo-resolve\s*\{[\s\S]*?var\(--startup-dither-2\)[\s\S]*?var\(--startup-dither-14\)/);
  assert.match(css, /\.startup-brand-icon\s*\{[^}]*mask-composite:\s*intersect;/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.startup-screen:not\(\[hidden\]\) \.startup-brand-icon,[^}]*animation:\s*none;/s);
  assert.match(css, /assets\/img\/hermes-browser-enter-gate-ink\.png/);
  assert.match(css, /\.shell::before\s*\{[^}]*hermes-browser-enter-gate-ink\.png[^}]*opacity:\s*0\.13;[^}]*mix-blend-mode:\s*normal;/s);
  // The Meander: a Greek key border is the progress bar, and the screen
  // switches on like an old TV.
  assert.match(js, /import \{ createStartupScreen \} from '\.\/lib\/startup-screen\.mjs'/);
  assert.match(css, /\.startup-meander-line\s*\{[^}]*stroke:\s*var\(--startup-line\)/s);
  // The ghosted HERMES caps rise above the backdrop's viewBox; it must not clip them.
  assert.match(css, /\.startup-backtype\s*\{[^}]*bottom:\s*0;[^}]*overflow:\s*visible;/s);
  assert.match(css, /@keyframes\s+startup-crt-on/);
  assert.doesNotMatch(css, /startup-scan-refined/);
  assert.match(css, /\.hero-wordmark\s*\{[^}]*width:\s*min\(205px,/s);
  assert.match(css, /\.app-scroll:has\(\.message\.user\)\s+\.hero-card\s*\{[^}]*display:\s*none;/s);

  // The chat no longer opens on the intro card; the wordmark lives in Settings.
  assert.equal(html.indexOf('class="hero-card"'), -1, 'the empty chat has no intro card');
  const statusCardIndex = html.indexOf('id="statusCard"');
  const browserBehaviorIndex = html.indexOf('id="browserBehaviorTitle"');
  const contextScopeButtonIndex = html.indexOf('id="contextScopeButton"');
  const composerStartIndex = html.indexOf('<form id="composer"');
  const composerEndIndex = html.indexOf('</form>', composerStartIndex);
  assert.ok(statusCardIndex > browserBehaviorIndex, 'active-tab status belongs in Browser Behavior settings');
  assert.ok(contextScopeButtonIndex > composerStartIndex && contextScopeButtonIndex < composerEndIndex, 'tab-scope control belongs in the composer header');
  assert.ok(contextScopeButtonIndex > html.indexOf('id="contextChip"'), 'tab-scope control sits right of the context chip');
});

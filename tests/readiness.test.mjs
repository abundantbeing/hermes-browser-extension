import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(css, /assets\/img\/hermes-browser-extension-icon-ink\.png/);
  assert.match(css, /\.startup-screen\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*place-items:\s*center;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /body\.startup-active\s+\.topbar\s*\{[^}]*top:\s*var\(--startup-settings-top,[^;]+\);[^}]*left:\s*50%;[^}]*justify-content:\s*center;[^}]*transform:\s*translateX\(-50%\);/s);
  assert.match(js, /function\s+positionStartupSettings[\s\S]*listRect\.bottom\s*\+\s*12/);
  assert.match(css, /body\.startup-active\s+\.topbar\s+#settingsButton\s*\{[^}]*pointer-events:\s*auto;/s);
  assert.match(css, /\.startup-brand-lockup\s*\{[^}]*justify-items:\s*center;/s);
  assert.doesNotMatch(html, /Connecting Browser Extension/i);
  assert.match(css, /\.startup-brand-icon\s*\{[^}]*width:\s*132px;/s);
  assert.match(css, /assets\/img\/hermes-browser-enter-gate-ink\.png/);
  assert.match(css, /\.shell::before\s*\{[^}]*hermes-browser-enter-gate-ink\.png[^}]*opacity:\s*0\.13;[^}]*mix-blend-mode:\s*normal;/s);
  assert.match(css, /\.startup-screen::after\s*\{[^}]*mix-blend-mode:\s*soft-light;[^}]*animation:\s*startup-scan-refined/s);
  assert.match(css, /@keyframes\s+startup-scan-refined/);
  assert.doesNotMatch(css, /@keyframes\s+startup-scan-refined\s*\{[^}]*opacity:\s*0\.72/s);
  assert.match(css, /\.hero-wordmark\s*\{[^}]*width:\s*min\(205px,/s);
  assert.match(css, /\.app-scroll:has\(\.message\.user\)\s+\.hero-card\s*\{[^}]*display:\s*none;/s);

  const heroIndex = html.indexOf('class="hero-card"');
  const messagesIndex = html.indexOf('id="messages"');
  const statusCardIndex = html.indexOf('id="statusCard"');
  const browserBehaviorIndex = html.indexOf('id="browserBehaviorTitle"');
  const contextScopeButtonIndex = html.indexOf('id="contextScopeButton"');
  const composerStartIndex = html.indexOf('<form id="composer"');
  const composerEndIndex = html.indexOf('</form>', composerStartIndex);
  assert.ok(heroIndex >= 0 && messagesIndex > heroIndex, 'hero should remain an intro before messages');
  assert.ok(statusCardIndex > browserBehaviorIndex, 'active-tab status belongs in Browser Behavior settings');
  assert.ok(contextScopeButtonIndex > composerStartIndex && contextScopeButtonIndex < composerEndIndex, 'tab-scope control belongs in the composer header');
  assert.ok(contextScopeButtonIndex < html.indexOf('id="contextChip"'), 'tab-scope control should render above the context chip');
  assert.doesNotMatch(html.slice(heroIndex, messagesIndex), /<span>ACTIVE TAB<\/span>/);
});

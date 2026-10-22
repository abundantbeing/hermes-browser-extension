import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  MESSAGE_LAYOUT_DEFAULT,
  RESPONSE_STYLE_DEFAULT,
  normalizeMessageLayout,
  normalizeResponseStyle,
  responsePresentationFromSettings,
  responseStyleInstructions,
  shouldShowOnboarding,
  withResponsePresentationUpdate,
} from '../extension/lib/response-presentation.mjs';
import { ONBOARDING_FONTS, ONBOARDING_STEPS, createOnboardingFlow, onboardingPreviewReply, onboardingSteps } from '../extension/lib/onboarding-flow.mjs';

const THEMES = [
  { value: 'nous', name: 'Nous', description: 'Blue', preview: { bg: '#0000ee', panel: '#0000ee', text: '#ffffff', muted: '#dddddd', accent: '#ffffff' }, previewLight: { bg: '#fafafa', panel: '#ffffff', text: '#0000f2', muted: '#7777ff', accent: '#0000f2' } },
  { value: 'mono', name: 'Mono', description: 'Gray', preview: { bg: '#111111', panel: '#111111', text: '#eeeeee', muted: '#999999', accent: '#222222' }, previewLight: { bg: '#f2f2f2', panel: '#ffffff', text: '#202020', muted: '#888888', accent: '#1d1d1d' } },
];

function click(element, window) {
  element.dispatchEvent(new window.Event('click', { bubbles: true }));
}

function key(element, window, name) {
  const event = new window.Event('keydown', { bubbles: true, cancelable: true });
  event.key = name;
  element.dispatchEvent(event);
  return event;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mountFlow(overrides = {}) {
  const { document, window } = parseHTML('<!doctype html><html><body><section id="host" hidden></section></body></html>');
  const host = document.getElementById('host');
  const state = { theme: 'nous', colorMode: 'dark', resolvedMode: 'dark', fontProfile: 'signature', responseStyle: 'vivid', messageLayout: 'bubbles', connection: { connected: false, status: '' } };
  const calls = [];
  const flow = createOnboardingFlow({
    host,
    themes: THEMES,
    translate: (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key),
    getState: () => state,
    renderReply: (style, text) => `<div data-rendered-style="${style}">${text.replace(/</g, '&lt;')}</div>`,
    onSelectTheme: (theme) => { state.theme = theme; calls.push(['theme', theme]); },
    onSelectMode: (mode) => { state.colorMode = mode; state.resolvedMode = mode === 'system' ? 'light' : mode; calls.push(['mode', mode]); },
    onSelectFont: (font) => { state.fontProfile = font; calls.push(['font', font]); },
    onSelectStyle: (style) => { state.responseStyle = style; calls.push(['style', style]); },
    onSelectLayout: (layout) => { state.messageLayout = layout; calls.push(['layout', layout]); },
    onConnect: () => calls.push(['connect']),
    onManualSetup: () => calls.push(['manual']),
    onFinish: (detail) => calls.push(['finish', detail.reason]),
    onReveal: (detail) => calls.push(['reveal', detail.reason]),
    onExited: (detail) => calls.push(['exited', detail.reason]),
    reducedMotion: () => true,
    wait: () => Promise.resolve(),
    ...overrides,
  });
  return { document, window, host, flow, state, calls };
}

test('presentation preferences normalize and keep other settings', () => {
  assert.equal(RESPONSE_STYLE_DEFAULT, 'rich');
  assert.equal(MESSAGE_LAYOUT_DEFAULT, 'bubbles');
  assert.equal(normalizeResponseStyle('VIVID'), 'vivid');
  assert.equal(normalizeResponseStyle('markdown'), 'rich');
  assert.equal(normalizeMessageLayout('user-bubble'), 'user-bubble');
  assert.equal(normalizeMessageLayout('left'), 'bubbles');
  assert.deepEqual(responsePresentationFromSettings({}), { responseStyle: 'rich', messageLayout: 'bubbles' });
  const next = withResponsePresentationUpdate({ appearanceTheme: 'mono', responseStyle: 'rich' }, { responseStyle: 'plain' });
  assert.deepEqual(next, { appearanceTheme: 'mono', responseStyle: 'plain' });
  assert.equal(withResponsePresentationUpdate({}, { messageLayout: '<script>' }).messageLayout, 'bubbles');
});

test('setup shows once for a new user only', () => {
  assert.equal(shouldShowOnboarding({}), true);
  assert.equal(shouldShowOnboarding({ completed: true }), false);
  assert.equal(shouldShowOnboarding({ legacyIntroSeen: true }), false, 'an existing user who used the panel skips it');
  assert.equal(shouldShowOnboarding({ messageCount: 2 }), false);
  assert.equal(shouldShowOnboarding({ completed: true, forced: true }), true, 'Settings can run it again');
});

test('response style system notes: rich and vivid add nothing (Vivid rides in each turn), plain asks for no Markdown', () => {
  assert.equal(responseStyleInstructions('rich'), '');
  assert.equal(responseStyleInstructions('vivid'), '', 'a session prompt saved under Vivid could not follow a later switch');
  assert.match(responseStyleInstructions('plain'), /no Markdown/);
});

test('setup walks theme, font, style, layout and Connect last, applying each choice live', async () => {
  const { host, flow, calls, window } = mountFlow();
  assert.deepEqual(ONBOARDING_STEPS, ['theme', 'font', 'style', 'layout', 'connect']);
  assert.equal(host.hidden, true);
  flow.open();
  assert.equal(host.hidden, false);
  assert.equal(flow.step, 'theme');
  assert.equal(host.querySelectorAll('[data-onboarding-theme]').length, 2);
  assert.equal(host.querySelector('[data-onboarding-theme="nous"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-onboarding-back]'), null, 'no Back on the first step');
  assert.ok(host.querySelector('[data-onboarding-skip]'), 'Skip on every step');

  click(host.querySelector('[data-onboarding-theme="mono"]'), window);
  assert.deepEqual(calls.at(-1), ['theme', 'mono']);
  assert.equal(host.querySelector('[data-onboarding-theme="mono"]').getAttribute('aria-checked'), 'true');

  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(flow.step, 'font');
  const fonts = [...host.querySelectorAll('[data-onboarding-font]')].map((node) => node.dataset.onboardingFont);
  assert.equal(fonts[0], 'signature', 'Hermes signature first');
  assert.ok(!fonts.includes('custom-local'), 'an installed local font needs a typed name, so it stays in Settings');
  assert.deepEqual(fonts, ONBOARDING_FONTS.map((font) => font.value));
  click(host.querySelector('[data-onboarding-font="georgia"]'), window);
  assert.deepEqual(calls.at(-1), ['font', 'georgia']);
  assert.equal(host.querySelector('[data-onboarding-font="georgia"]').getAttribute('aria-checked'), 'true');
  assert.match(host.querySelector('[data-onboarding-font="georgia"]').getAttribute('style'), /Georgia/, 'each font card draws in its own face');

  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(flow.step, 'style');
  const styles = [...host.querySelectorAll('[data-onboarding-style]')].map((node) => node.dataset.onboardingStyle);
  assert.deepEqual(styles, ['vivid', 'rich', 'plain']);
  click(host.querySelector('[data-onboarding-style="plain"]'), window);
  assert.deepEqual(calls.at(-1), ['style', 'plain']);

  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(flow.step, 'layout');
  const layouts = [...host.querySelectorAll('[data-onboarding-layout]')].map((node) => node.dataset.onboardingLayout);
  assert.deepEqual(layouts, ['bubbles', 'user-bubble']);
  click(host.querySelector('[data-onboarding-layout="user-bubble"]'), window);
  assert.deepEqual(calls.at(-1), ['layout', 'user-bubble']);

  click(host.querySelector('[data-onboarding-back]'), window);
  assert.equal(flow.step, 'style');
  click(host.querySelector('[data-onboarding-next]'), window);
  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(flow.step, 'connect', 'Connect to Hermes is the last step');
  assert.ok(host.querySelector('[data-onboarding-connect]'));
  assert.ok(host.querySelector('[data-onboarding-manual]'));
  assert.equal(host.querySelector('.onboarding-body').textContent, 'onboarding.connect.body', 'a line on what pairing does');
  click(host.querySelector('[data-onboarding-connect]'), window);
  click(host.querySelector('[data-onboarding-manual]'), window);
  assert.deepEqual(calls.slice(-2), [['connect'], ['manual']]);
  assert.equal(host.querySelector('[data-onboarding-next]').textContent.trim(), 'onboarding.connect.later');

  click(host.querySelector('[data-onboarding-next]'), window);
  assert.equal(flow.isOpen, false);
  await settle();
  assert.deepEqual(calls.slice(-3), [['finish', 'later'], ['reveal', 'later'], ['exited', 'later']]);
  assert.equal(host.hidden, true);
});

test('an already paired panel skips the Connect step', async () => {
  const { host, flow, calls, window, state } = mountFlow();
  state.connection = { connected: true };
  flow.open({ includeConnect: false });
  assert.deepEqual(flow.steps, ['theme', 'font', 'style', 'layout']);
  assert.deepEqual(onboardingSteps({ includeConnect: false }), flow.steps);
  flow.open({ step: 'layout', includeConnect: false });
  assert.equal(host.querySelector('[data-onboarding-next]').textContent.trim(), 'onboarding.start');
  click(host.querySelector('[data-onboarding-next]'), window);
  await settle();
  assert.deepEqual(calls.at(0), ['finish', 'done']);
});

test('light, dark and system recolour the theme cards and persist the mode', () => {
  const { host, flow, calls, window } = mountFlow();
  flow.open();
  const modes = [...host.querySelectorAll('[data-onboarding-mode]')].map((node) => node.dataset.onboardingMode);
  assert.deepEqual(modes, ['light', 'dark', 'system']);
  assert.equal(host.querySelector('[data-onboarding-mode="dark"]').getAttribute('aria-checked'), 'true');
  assert.match(host.querySelector('[data-onboarding-theme="nous"]').getAttribute('style'), /--preview-bg:#0000ee/);
  click(host.querySelector('[data-onboarding-mode="light"]'), window);
  assert.deepEqual(calls.at(-1), ['mode', 'light']);
  assert.equal(host.querySelector('[data-onboarding-mode="light"]').getAttribute('aria-checked'), 'true');
  assert.match(host.querySelector('[data-onboarding-theme="nous"]').getAttribute('style'), /--preview-bg:#fafafa/, 'light cards');
  assert.equal(host.querySelector('.onboarding-theme-grid').dataset.previewMode, 'light');
  click(host.querySelector('[data-onboarding-mode="system"]'), window);
  assert.deepEqual(calls.at(-1), ['mode', 'system']);
  assert.equal(host.querySelector('[data-onboarding-mode="system"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelectorAll('[data-onboarding-mode] svg[data-icon]').length, 3);
});

test('the live preview is a real user message and Hermes reply that follows every pick', () => {
  const { host, flow, state, window } = mountFlow();
  flow.open();
  const preview = host.querySelector('.onboarding-preview');
  assert.equal(preview.getAttribute('aria-hidden'), 'true');
  assert.ok(preview.querySelector('.message-row[data-role="user"] > .message.user .message-content'));
  assert.ok(preview.querySelector('.message-row[data-role="assistant"] > .message.assistant .message-content'));
  assert.equal(preview.querySelector('[data-rendered-style]').dataset.renderedStyle, 'vivid');
  assert.match(preview.textContent, /hermes-ui/, 'Vivid UI goes through the Adaptive UI renderer with a static block');
  click(host.querySelector('[data-onboarding-next]'), window);
  click(host.querySelector('[data-onboarding-next]'), window);
  click(host.querySelector('[data-onboarding-style="plain"]'), window);
  assert.equal(preview.querySelector('[data-rendered-style]').dataset.renderedStyle, 'plain');
  assert.equal(preview.dataset.style, 'plain');
  const before = preview.innerHTML;
  state.messageLayout = 'user-bubble';
  flow.render();
  assert.ok(host.querySelector('.onboarding-preview .message.assistant'), 'layout moves the bubbles through the real layout CSS');
  assert.equal(preview.innerHTML, before, 'the same conversation, laid out by the page');
});

test('preview replies: Vivid carries a chart block, Rich is Markdown, Plain is flat', () => {
  const vivid = onboardingPreviewReply('vivid');
  const fence = vivid.match(/```hermes-ui\n([\s\S]*?)\n```/);
  assert.ok(fence, 'a hermes-ui fence');
  const envelope = JSON.parse(fence[1]);
  assert.equal(envelope.schema, 'hermes.adaptive-ui');
  assert.equal(envelope.blocks[0].type, 'chart');
  assert.match(onboardingPreviewReply('rich'), /^\*\*/);
  assert.match(onboardingPreviewReply('rich'), /\n- /);
  assert.doesNotMatch(onboardingPreviewReply('plain'), /[*#`]|^- /m);
});

test('Skip ends setup from any step and keeps what was picked', async () => {
  const { host, flow, calls, window } = mountFlow();
  flow.open({ step: 'style' });
  click(host.querySelector('[data-onboarding-style="rich"]'), window);
  click(host.querySelector('[data-onboarding-skip]'), window);
  await settle();
  assert.deepEqual(calls, [['style', 'rich'], ['finish', 'skip'], ['reveal', 'skip'], ['exited', 'skip']]);
  assert.equal(flow.isOpen, false);
  assert.equal(host.hidden, true);
});

test('arrow keys turn the page outside radio groups and move the pick inside them', () => {
  const { host, flow, calls, window } = mountFlow();
  flow.open();
  key(host.querySelector('.onboarding-title'), window, 'ArrowRight');
  assert.equal(flow.step, 'font');
  key(host.querySelector('.onboarding-title'), window, 'ArrowLeft');
  assert.equal(flow.step, 'theme');
  key(host.querySelector('[data-onboarding-theme="nous"]'), window, 'ArrowRight');
  assert.equal(flow.step, 'theme', 'arrows inside the theme grid pick a theme');
  assert.deepEqual(calls.at(-1), ['theme', 'mono']);
});

test('a swipe turns the page', () => {
  const { host, flow, window } = mountFlow();
  flow.open();
  const pointer = (type, x, y) => {
    const event = new window.Event(type, { bubbles: true });
    Object.assign(event, { clientX: x, clientY: y, isPrimary: true });
    host.querySelector('.onboarding-stage').dispatchEvent(event);
  };
  pointer('pointerdown', 300, 200);
  pointer('pointerup', 180, 210);
  assert.equal(flow.step, 'font');
  pointer('pointerdown', 100, 200);
  pointer('pointerup', 260, 205);
  assert.equal(flow.step, 'theme');
  pointer('pointerdown', 100, 200);
  pointer('pointerup', 110, 320);
  assert.equal(flow.step, 'theme', 'a vertical drag is a scroll, not a swipe');
});

test('the screen is labelled for screen readers and announces each step', () => {
  const { host, flow, window } = mountFlow();
  flow.open();
  assert.equal(host.querySelector('.onboarding-logo').getAttribute('role'), 'img');
  assert.equal(host.querySelector('.onboarding-stage').getAttribute('aria-labelledby'), 'onboardingStepTitle');
  assert.equal(host.querySelector('#onboardingStepTitle').getAttribute('tabindex'), '-1');
  click(host.querySelector('[data-onboarding-next]'), window);
  assert.match(host.querySelector('.onboarding-announce').textContent, /onboarding\.step_count.*onboarding\.font\.title/);
  assert.equal(host.querySelector('.onboarding-announce').getAttribute('aria-live'), 'polite');
});

test('connecting on the last step shows it and lets the user straight in', async () => {
  const { host, flow, calls, state, window } = mountFlow();
  flow.open({ step: 'connect' });
  state.connection = { connected: false, busy: true, busyLabel: 'Connecting...' };
  flow.render();
  assert.ok(host.querySelector('[data-onboarding-connect]').hasAttribute('disabled'));
  state.connection = { connected: true };
  flow.render();
  assert.ok(host.querySelector('.onboarding-connect.is-connected'));
  assert.equal(host.querySelector('[data-onboarding-next]').textContent.trim(), 'onboarding.start');
  click(host.querySelector('[data-onboarding-next]'), window);
  await settle();
  assert.deepEqual(calls.at(0), ['finish', 'done']);
});

test('setup copy never names another product and escapes theme names', () => {
  const { host, flow } = mountFlow({ themes: [{ value: 'x', name: '<img src=x onerror=alert(1)>', preview: {} }] });
  flow.open();
  assert.equal(host.querySelector('img'), null);
  const english = fs.readFileSync(new URL('../extension/lib/locales/en.mjs', import.meta.url), 'utf8');
  const setupCopy = english.split('\n').filter((line) => /"(onboarding|responses)\./.test(line)).join('\n');
  assert.ok(setupCopy.length > 0);
  assert.doesNotMatch(setupCopy, /iMessage|WhatsApp|Telegram|ChatGPT|Messenger/i);
});

test('side panel replaces the old first-run block with setup and offers it again in Settings', () => {
  const html = fs.readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(html, /id="onboardingFlow"[^>]*hidden/);
  assert.match(html, /id="responseStyleChoices"/);
  assert.match(html, /id="messageLayoutChoices"/);
  assert.match(html, /id="rerunOnboardingButton"/);
  assert.doesNotMatch(js, /THE PAGE IS THE PROMPT/);
  assert.match(js, /ONBOARDING_COMPLETED_STORAGE_KEY/);
  assert.match(js, /els\.rerunOnboardingButton\?\.addEventListener\('click'[\s\S]{0,120}openOnboarding\(\)/);
});

test('setup fills the panel after the startup screen settles, with no chat chrome under it', () => {
  const html = fs.readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(html, /id="onboardingFlow"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(css, /\.onboarding \{[^}]*position: fixed;[^}]*inset: 0;/s, 'full length, top to bottom');
  assert.match(css, /body\.onboarding-active \.topbar,\s*body\.onboarding-active \.bottom-dock \{ visibility: hidden; \}/, 'no top bar, composer or model picker');
  assert.match(css, /body\.onboarding-active #messages \{ display: none; \}/, 'no chat thread');
  const maybeOpen = js.match(/function maybeOpenOnboarding\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(maybeOpen, /if \(!startupReadinessSettled\(\)\) return;/, 'loading screen first, then setup');
  assert.match(maybeOpen, /setResponsePresentation\(\{ responseStyle: RESPONSE_STYLE_SETUP_DEFAULT \}\)/, 'the Vivid preselection is saved, so an appearance save cannot drop it');
  const renderStartup = js.match(/function renderStartupReadiness\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(renderStartup, /maybeOpenOnboarding\(\);/);
  assert.match(renderStartup, /if \(connectDeferred && !view\.ready\) view\.visible = false;/, '"Connect later" opens the panel unpaired');
  const open = js.match(/function openOnboarding\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(open, /includeConnect = !isConnected\(\)/, 'a paired panel, or a rerun from Settings once paired, skips Connect');
  assert.match(open, /getBoundingClientRect/, 'the logo flies up from the startup screen');
  assert.match(js, /onConnect: \(\) => \{\s*connectToHermes\(\)/, 'the Connect step pairs through the same code as the pop-up');
  assert.match(js, /onManualSetup: \(\) => openSettingsDialog\(\{ pane: 'connections' \}\)/, 'Manual setup opens Settings > Connections');
});

test('Skip and finish both mark setup done and play the way into the chat', () => {
  const js = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  const complete = js.match(/async function completeOnboarding\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(complete, /onboardingCompleted = true;/);
  assert.match(complete, /\[ONBOARDING_COMPLETED_STORAGE_KEY\]: true/);
  assert.match(complete, /connectDialogDismissed = true;/, 'leaving setup unpaired does not throw the connect pop-up at the user');
  assert.match(js, /onFinish: \(\{ reason \}\) => \{ void completeOnboarding\(reason\); \}/);
  assert.match(js, /onReveal: \(\) => revealPanelAfterOnboarding\(\)/);
  assert.match(js, /onExited: \(\) => settlePanelAfterOnboarding\(\)/);
  assert.match(js, /function revealPanelAfterOnboarding\(\) \{[\s\S]*?classList\.add\('onboarding-entering'\)/);
  assert.match(js, /function settlePanelAfterOnboarding\(\) \{[\s\S]*?showFirstPrompt\(\);/);
  assert.match(css, /body\.onboarding-entering \.topbar \{ animation: onboarding-chrome-down/);
  assert.match(css, /body\.onboarding-entering \.bottom-dock \{ animation: onboarding-chrome-up/);
  assert.match(css, /\.onboarding\.is-exiting \{ animation: onboarding-dither-out/);
  assert.match(css, /\.onboarding\.is-finishing \.startup-meander-line/, 'the Meander closes its loop first');
});

test('the first suggested prompt fills the composer and never sends', () => {
  const html = fs.readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(html, /id="firstPromptChips"[^>]*hidden/);
  assert.match(html, /id="firstPromptChip"[^>]*data-i18n="onboarding\.preview\.user"/);
  const use = js.match(/function useFirstPrompt\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(use, /els\.input\.value = t\('onboarding\.preview\.user'\)/);
  assert.doesNotMatch(use, /askHermes|requestSubmit|submit\(/);
  assert.match(js, /els\.composer\?\.addEventListener\('submit', hideFirstPrompt, \{ capture: true \}\)/);
});

test('reduced motion swaps every setup animation for a plain fade', () => {
  const css = fs.readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{\n {2}\.onboarding\.is-entering > \*,[\s\S]*?\n\}/)?.[0] || '';
  for (const selector of ['.onboarding-stage.is-switching', '.onboarding-preview.is-repainting', 'body.onboarding-entering .topbar', 'body.onboarding-entering .bottom-dock', '.first-prompt-chip']) {
    assert.ok(block.includes(selector), selector);
  }
  assert.match(block, /\.onboarding\.is-exiting \{ animation: onboarding-fade-out 0\.2s ease both; \}/);
});

test('reduced motion: setup still runs every callback, without waiting on the long animation', async () => {
  const waits = [];
  const { host, flow, calls, window } = mountFlow({ wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
  flow.open({ step: 'layout' });
  click(host.querySelector('[data-onboarding-skip]'), window);
  await settle();
  assert.deepEqual(waits, [220], 'one short fade, no Meander beat');
  assert.deepEqual(calls.map(([name]) => name), ['finish', 'reveal', 'exited']);
});

// First-run setup: language, theme and colour mode, font, response style, chat
// layout, then Connect to Hermes last. It fills the whole side panel and continues the
// startup screen's world: the Meander border (drawn as the setup's progress),
// the logo small at the top, steps switching on like an old screen. A small
// fake conversation at the top of every step shows each pick at once.
// Every choice applies live through the callbacks (the same code paths the
// Settings controls use), so leaving the flow early keeps what was picked.
// DOM only through the host and document passed in; no storage here.

import { escapeHtml } from './common.mjs';
import { themePreviewForMode } from './appearance-themes.mjs';
import { fontFamilyPreview } from './appearance-preferences.mjs';
import { handleRadioCardKeydown, presentationCardsHtml, presentationOptionLabelKey } from './presentation-previews.mjs';
import { contrastRatio, meanderGeometry } from './startup-screen.mjs';

export const ONBOARDING_STEPS = Object.freeze(['language', 'theme', 'font', 'style', 'layout', 'connect']);

export function onboardingSteps({ includeConnect = true } = {}) {
  return includeConnect ? [...ONBOARDING_STEPS] : ONBOARDING_STEPS.filter((step) => step !== 'connect');
}

// Unmodified pixelarticons glyphs (tests/pixel-icons.test.mjs checks them).
export const ONBOARDING_ICONS = Object.freeze({
  light: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="sun"><path d="M13 22h-2v-3h2v3Zm-6-3H5v-2h2v2Zm12 0h-2v-2h2v2Zm-4-2H9v-2h6v2Zm-6-2H7V9h2v6Zm8 0h-2V9h2v6ZM5 13H2v-2h3v2Zm17 0h-3v-2h3v2Zm-7-4H9V7h6v2ZM7 7H5V5h2v2Zm12 0h-2V5h2v2Zm-6-2h-2V2h2v3Z"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="moon"><path d="M18 22H8v-2h10v2ZM8 20H6v-2h2v2Zm12 0h-2v-2h2v2ZM6 18H4v-2h2v2Zm16 0h-2v-4h-2v-2h2v-2h2v8ZM4 16H2V6h2v10Zm14 0h-6v-2h6v2Zm-6-2h-2v-2h2v2Zm-2-2H8V6h2v6ZM6 6H4V4h2v2Zm8-2h-2v2h-2V4H6V2h8v2Z"/></svg>',
  system: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="monitor"><path d="M4 2h16v2H4zm0 14h16v2H4zM2 4h2v12H2zm18 0h2v12h-2zm-9 14h2v2h-2zm-3 2h8v2H8z"/></svg>',
  connect: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="plug"><path d="M16 18h-3v4h-2v-4H8v-2h8v2Zm-8-2H6v-2h2v2Zm10 0h-2v-2h2v2Zm-8-9h4V2h2v5h5v2h-1v5h-2V9H6v5H4V9H3V7h5V2h2v5Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="arrow-left"><path d="M20 11v2H4v-2zM8 13v2H6v-2zm2 2v2H8v-2zm2 2v2h-2v-2zm-4-6V9H6v2z"/><path d="M10 15V7H8v8zm2 2V5h-2v12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="arrow-right"><path d="M4 11v2h16v-2zm12 2v2h2v-2zm-2 2v2h2v-2zm-2 2v2h2v-2zm4-6V9h2v2z"/><path d="M14 15V7h2v8zm-2 2V5h2v12z"/></svg>',
  connected: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" data-icon="check"><path d="M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z"/></svg>',
});

export const ONBOARDING_COLOR_MODES = Object.freeze([
  { value: 'light', label: 'settings.mode.light' },
  { value: 'dark', label: 'settings.mode.dark' },
  { value: 'system', label: 'settings.mode.system' },
]);

// Every font Settings offers except an installed local font, which needs a
// typed family name; Hermes signature first.
export const ONBOARDING_FONTS = Object.freeze([
  { value: 'signature', label: 'appearance.font_signature' },
  { value: 'collapse', label: 'appearance.font_collapse' },
  { value: 'system-sans', label: 'appearance.font_system_sans' },
  { value: 'high-legibility', label: 'appearance.font_high_legibility' },
  { value: 'space-grotesk', label: 'appearance.font_space_grotesk' },
  { value: 'ibm-plex-sans', label: 'appearance.font_ibm_plex' },
  { value: 'source-sans-3', label: 'appearance.font_source_sans' },
  { value: 'outfit', label: 'appearance.font_outfit' },
  { value: 'montserrat', label: 'appearance.font_montserrat' },
  { value: 'mono', label: 'appearance.font_monospace' },
  { value: 'georgia', label: 'appearance.font_georgia' },
  { value: 'libre-baskerville', label: 'appearance.font_libre_baskerville' },
  { value: 'fraunces', label: 'appearance.font_fraunces' },
  { value: 'playfair-display', label: 'appearance.font_playfair' },
  { value: 'cinzel', label: 'appearance.font_cinzel' },
  { value: 'garamond', label: 'appearance.font_garamond' },
  { value: 'palatino', label: 'appearance.font_palatino' },
  { value: 'times-new-roman', label: 'appearance.font_times' },
  { value: 'cambria', label: 'appearance.font_cambria' },
  { value: 'calibri', label: 'appearance.font_calibri' },
  { value: 'trebuchet', label: 'appearance.font_trebuchet' },
]);

export function responseStyleLabelKey(style) {
  return presentationOptionLabelKey('style', style);
}

export function messageLayoutLabelKey(layout) {
  return presentationOptionLabelKey('layout', layout);
}

// The reply in the preview, as each response style would draw it. Vivid UI
// carries a static Adaptive UI block, so the real renderer draws a real card.
export function onboardingPreviewReply(style, t = (key) => key) {
  const points = [t('onboarding.preview.point_1'), t('onboarding.preview.point_2'), t('onboarding.preview.point_3')];
  if (style === 'plain') return `${t('onboarding.preview.lead')}\n\n${points.map((point, index) => `${index + 1}. ${point}`).join('\n')}`;
  if (style === 'vivid') {
    const envelope = {
      schema: 'hermes.adaptive-ui',
      version: 1,
      blocks: [{ id: 'onboarding-chart', type: 'chart', title: t('onboarding.preview.chart'), kind: 'bar', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: t('onboarding.preview.chart'), values: [3.1, 2.4, 1.8, 1.2] }] }],
    };
    return `${t('onboarding.preview.lead')}\n\n\`\`\`hermes-ui\n${JSON.stringify(envelope)}\n\`\`\``;
  }
  return `**${t('onboarding.preview.lead')}**\n\n${points.map((point) => `- ${point}`).join('\n')}`;
}

function themeCard(theme, selected, mode) {
  const p = themePreviewForMode(theme, mode);
  const style = `--preview-bg:${p.bg};--preview-panel:${p.panel};--preview-text:${p.text};--preview-muted:${p.muted};--preview-accent:${p.accent};`;
  return `
    <button class="theme-card${selected ? ' selected' : ''}" type="button" data-onboarding-theme="${escapeHtml(theme.value)}" data-radio-key="${escapeHtml(`theme:${theme.value}`)}" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" aria-label="${escapeHtml(theme.name)}" title="${escapeHtml(`${theme.name}: ${theme.description || ''}`)}" style="${escapeHtml(style)}">
      <span class="theme-preview" aria-hidden="true"><span></span><span></span><span></span></span>
      <span class="theme-card-copy"><strong>${escapeHtml(theme.name)}</strong></span>
      <span class="theme-check" aria-hidden="true"></span>
    </button>`;
}

const SWIPE_DISTANCE = 56;
const CONNECTED_FINISH_MS = 1400;

export function createOnboardingFlow({
  host,
  themes = [],
  // The supported locales ({ id, nativeName, direction }) from the locale
  // registry, the same list Settings > Language shows.
  languages = [],
  fonts = ONBOARDING_FONTS,
  translate = (key) => key,
  getState = () => ({}),
  renderReply = (style, text) => `<p>${escapeHtml(text)}</p>`,
  roleLabels = { user: 'You', assistant: 'Hermes' },
  onSelectLanguage = () => {},
  // Called with the step's name just before setup leaves it (Next, Back or
  // finishing), so a suggestion that was never picked can be kept.
  onLeaveStep = () => {},
  onSelectTheme = () => {},
  onSelectMode = () => {},
  onSelectFont = () => {},
  onSelectStyle = () => {},
  onSelectLayout = () => {},
  onConnect = () => {},
  onManualSetup = () => {},
  onFinish = () => {},
  onReveal = () => {},
  onExited = () => {},
  reducedMotion = () => Boolean(host?.ownerDocument?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
  wait = (ms) => new Promise((resolve) => (host?.ownerDocument?.defaultView || globalThis).setTimeout(resolve, ms)),
} = {}) {
  const doc = host?.ownerDocument;
  let steps = onboardingSteps();
  let stepIndex = 0;
  let open = false;
  let exiting = false;
  let parts = null;
  let previewKey = '';
  let wasConnected = false;
  let connectedTimer = 0;
  // The pairing approval page, shown in the Connect step while it waits. One
  // element for the whole approval: rebuilding the step would reload it.
  let approvalNode = null;
  let meanderSize = '';
  let meanderParts = null;
  // The language the static shell (Skip, the nav's label) was last drawn in.
  let shellLocale = '';
  const t = (key, values) => translate(key, values);
  const view = () => doc?.defaultView || globalThis;

  function shellHtml() {
    return `
      <svg class="startup-meander onboarding-meander" aria-hidden="true"></svg>
      <header class="onboarding-top">
        <span class="onboarding-logo" role="img" aria-label="${escapeHtml(t('manifest.extension_name'))}"></span>
        <div class="onboarding-head">
          <span class="onboarding-count"></span>
          <button type="button" class="onboarding-skip secondary" data-onboarding-skip>${escapeHtml(t('onboarding.skip'))}</button>
        </div>
      </header>
      <div class="onboarding-preview" aria-hidden="true"></div>
      <div class="onboarding-stage" role="group" aria-labelledby="onboardingStepTitle"></div>
      <nav class="onboarding-nav" aria-label="${escapeHtml(t('onboarding.aria'))}">
        <button type="button" class="onboarding-nav-button" data-onboarding-back></button>
        <span class="onboarding-progress" aria-hidden="true"></span>
        <button type="button" class="onboarding-nav-button onboarding-nav-next" data-onboarding-next></button>
      </nav>
      <p class="onboarding-announce sr-only" aria-live="polite"></p>
      <i class="onboarding-probe" hidden></i>`;
  }

  // The language step reads before a choice: its heading and body come in the
  // language that is about to be used (the browser's suggestion, or the one in
  // force), with the heading repeated in English beneath it.
  function languageView(state) {
    const language = state.language || {};
    const selected = language.selected || language.current || 'en';
    const known = languages.find((entry) => entry.id === selected);
    return {
      selected,
      lang: selected,
      dir: known?.direction || 'ltr',
      title: language.copy?.title || t('onboarding.language.title'),
      body: language.copy?.body || t('onboarding.language.body'),
      english: selected === 'en' ? '' : (language.english?.title || ''),
    };
  }

  function stepBody(step, state) {
    if (step === 'language') {
      const { selected } = languageView(state);
      const cards = languages.map((entry) => {
        const isSelected = entry.id === selected;
        return `<button class="onboarding-language-card${isSelected ? ' selected' : ''}" type="button" role="radio" aria-checked="${isSelected}" tabindex="${isSelected ? 0 : -1}" lang="${escapeHtml(entry.id)}" dir="${entry.direction === 'rtl' ? 'rtl' : 'ltr'}" data-onboarding-language="${escapeHtml(entry.id)}" data-radio-key="language:${escapeHtml(entry.id)}"><span class="onboarding-language-name">${escapeHtml(entry.nativeName)}</span><span class="presentation-card-check" aria-hidden="true"></span></button>`;
      }).join('');
      return `<div class="onboarding-language-grid" role="radiogroup" aria-label="${escapeHtml(languageView(state).title)}">${cards}</div>`;
    }
    if (step === 'theme') {
      const mode = state.resolvedMode === 'light' ? 'light' : 'dark';
      const modes = ONBOARDING_COLOR_MODES.map((option) => {
        const selected = option.value === (state.colorMode || 'dark');
        return `<button class="mode-choice${selected ? ' selected' : ''}" type="button" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" data-onboarding-mode="${option.value}" data-radio-key="mode:${option.value}">${ONBOARDING_ICONS[option.value]}<span>${escapeHtml(t(option.label))}</span></button>`;
      }).join('');
      const cards = themes.map((theme) => themeCard(theme, theme.value === state.theme, mode)).join('');
      return `
        <div class="segmented-control mode-switch onboarding-mode" role="radiogroup" aria-label="${escapeHtml(t('ui.color.mode.588a2981'))}">${modes}</div>
        <div class="theme-grid onboarding-theme-grid" role="radiogroup" aria-label="${escapeHtml(t('onboarding.theme.title'))}" data-preview-mode="${mode}">${cards}</div>`;
    }
    if (step === 'font') {
      const cards = fonts.map((font) => {
        const selected = font.value === (state.fontProfile || 'signature');
        const family = fontFamilyPreview(font.value);
        return `<button class="onboarding-font-card${selected ? ' selected' : ''}" type="button" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" data-onboarding-font="${escapeHtml(font.value)}" data-radio-key="font:${escapeHtml(font.value)}" style="${escapeHtml(`--onboarding-font:${family}`)}"><span class="onboarding-font-sample" aria-hidden="true">Aa</span><span class="onboarding-font-name">${escapeHtml(t(font.label))}</span><span class="presentation-card-check" aria-hidden="true"></span></button>`;
      }).join('');
      return `<div class="onboarding-font-grid" role="radiogroup" aria-label="${escapeHtml(t('onboarding.font.title'))}">${cards}</div>`;
    }
    // The same visual cards Settings shows, so setup and Settings match.
    if (step === 'style') {
      const cards = presentationCardsHtml('style', { selected: state.responseStyle, attribute: 'data-onboarding-style', translate: t });
      return `<div class="presentation-choices onboarding-options" role="radiogroup" aria-label="${escapeHtml(t('onboarding.style.title'))}">${cards}</div>`;
    }
    if (step === 'layout') {
      const cards = presentationCardsHtml('layout', { selected: state.messageLayout, attribute: 'data-onboarding-layout', translate: t });
      return `<div class="presentation-choices onboarding-options" role="radiogroup" aria-label="${escapeHtml(t('onboarding.layout.title'))}">${cards}</div>`;
    }
    const connection = state.connection || {};
    const connected = Boolean(connection.connected);
    const status = connected ? t('onboarding.connect.connected') : (connection.status || t('onboarding.connect.not_paired'));
    return `
      <div class="onboarding-connect${connected ? ' is-connected' : ''}${connection.busy ? ' is-busy' : ''}${connectFailed(connection) ? ' is-failed' : ''}${approvalNode ? ' is-approving' : ''}">
        <p class="onboarding-connect-status" role="status">${connected ? ONBOARDING_ICONS.connected : ''}<span>${escapeHtml(status)}</span></p>
        ${approvalNode ? '<div class="onboarding-approval-slot"></div>' : ''}
        <div class="onboarding-connect-actions"${connected ? ' hidden' : ''}>
          <button type="button" class="onboarding-connect-button" data-onboarding-connect${connection.busy ? ' disabled' : ''}>${ONBOARDING_ICONS.connect}<span>${escapeHtml(connection.busy ? (connection.busyLabel || t('ui.connect.to.hermes')) : t('ui.connect.to.hermes'))}</span></button>
          <button type="button" class="secondary" data-onboarding-manual>${escapeHtml(t('ui.manual.setup'))}</button>
        </div>
      </div>`;
  }

  // A failed attempt stays on the Connect step: the reason is the status line
  // and Manual setup is the way on. Nothing here opens Settings by itself.
  function connectFailed(connection) {
    return Boolean(connection.failed) && !connection.connected && !connection.busy;
  }

  function previewHtml(state) {
    const style = state.responseStyle || 'rich';
    const reply = renderReply(style, onboardingPreviewReply(style, t));
    return `
      <div class="onboarding-preview-thread">
        <div class="message-row" data-role="user"><article class="message user"><div class="message-role">${escapeHtml(roleLabels.user)}</div><div class="message-content"><p>${escapeHtml(t('onboarding.preview.user'))}</p></div></article></div>
        <div class="message-row" data-role="assistant"><article class="message assistant"><div class="message-role">${escapeHtml(roleLabels.assistant)}</div><div class="message-content">${reply}</div></article></div>
      </div>`;
  }

  // Replays a CSS animation by toggling its class.
  function replay(node, className) {
    if (!node || reducedMotion()) return;
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
  }

  function renderPreview(state, { force = false } = {}) {
    if (!parts) return;
    const key = JSON.stringify([state.theme, state.resolvedMode, state.fontProfile, state.responseStyle, state.messageLayout, state.language?.current || '']);
    if (!force && key === previewKey) return;
    const repaint = previewKey && key !== previewKey;
    previewKey = key;
    parts.preview.innerHTML = previewHtml(state);
    parts.preview.dataset.style = state.responseStyle || 'rich';
    if (repaint) replay(parts.preview, 'is-repainting');
  }

  function renderMeta(step) {
    const total = steps.length;
    parts.progress.innerHTML = steps.map((_, index) => `<i class="${index === stepIndex ? 'active' : ''}${index < stepIndex ? ' done' : ''}"></i>`).join('');
    parts.count.textContent = t('onboarding.step_count', { current: stepIndex + 1, total });
    host.dataset.step = step;
  }

  // Back and Next are icon buttons set into the border, named for screen
  // readers and labelled on hover and focus. The last step finishes with a
  // check, or moves on with the arrow when Connect is left for later.
  function setNavButton(button, label, icon) {
    button.setAttribute('aria-label', label);
    button.dataset.tip = label;
    if (button.dataset.icon !== icon) {
      button.innerHTML = ONBOARDING_ICONS[icon];
      button.dataset.icon = icon;
    }
  }

  function renderNav(step, state) {
    const last = stepIndex === steps.length - 1;
    const later = last && step === 'connect' && !state.connection?.connected;
    const nextLabel = !last ? t('onboarding.next') : later ? t('onboarding.connect.later') : t('onboarding.start');
    setNavButton(parts.back, t('onboarding.back'), 'back');
    parts.back.hidden = stepIndex === 0;
    setNavButton(parts.next, nextLabel, last && !later ? 'connected' : 'next');
    parts.next.classList.toggle('is-finish', last && !later);
  }

  // While the approval page is up, a status update changes the words and the
  // buttons in place; replacing the step would reload the page being read.
  function patchConnectStage(state) {
    const connection = state.connection || {};
    const connected = Boolean(connection.connected);
    const root = parts.stage.querySelector('.onboarding-connect');
    root.classList.toggle('is-connected', connected);
    root.classList.toggle('is-busy', Boolean(connection.busy));
    root.classList.toggle('is-failed', connectFailed(connection));
    const label = parts.stage.querySelector('.onboarding-connect-status span');
    if (label) label.textContent = connected ? t('onboarding.connect.connected') : (connection.status || t('onboarding.connect.not_paired'));
    const actions = parts.stage.querySelector('.onboarding-connect-actions');
    if (actions) actions.hidden = connected;
    const button = parts.stage.querySelector('[data-onboarding-connect]');
    if (button) button.disabled = Boolean(connection.busy);
  }

  function renderStage(step, state) {
    if (step === 'connect' && approvalNode && parts.stage.dataset.step === 'connect' && parts.stage.contains(approvalNode)) {
      patchConnectStage(state);
      return;
    }
    parts.stage.dataset.step = step;
    if (step === 'language') {
      const view = languageView(state);
      parts.stage.innerHTML = `
        <h2 class="onboarding-title" id="onboardingStepTitle" tabindex="-1" lang="${escapeHtml(view.lang)}" dir="${view.dir}">${escapeHtml(view.title)}</h2>
        ${view.english ? `<p class="onboarding-title-english" lang="en" dir="ltr">${escapeHtml(view.english)}</p>` : ''}
        <p class="onboarding-body" lang="${escapeHtml(view.lang)}" dir="${view.dir}">${escapeHtml(view.body)}</p>
        ${stepBody(step, state)}`;
      return;
    }
    parts.stage.innerHTML = `
      <h2 class="onboarding-title" id="onboardingStepTitle" tabindex="-1">${escapeHtml(t(`onboarding.${step}.title`))}</h2>
      <p class="onboarding-body">${escapeHtml(t(`onboarding.${step}.body`))}</p>
      ${stepBody(step, state)}`;
    if (step === 'connect' && approvalNode) parts.stage.querySelector('.onboarding-approval-slot')?.append(approvalNode);
  }

  function focusKey() {
    const active = doc?.activeElement;
    if (!active || !host.contains(active)) return null;
    if (active.dataset?.radioKey) return { radio: active.dataset.radioKey };
    for (const attribute of ['data-onboarding-next', 'data-onboarding-back', 'data-onboarding-skip', 'data-onboarding-connect', 'data-onboarding-manual']) {
      if (active.hasAttribute?.(attribute)) return { attribute };
    }
    return null;
  }

  function restoreFocus(key) {
    if (!key) return;
    const target = key.radio
      ? [...host.querySelectorAll('[data-radio-key]')].find((node) => node.dataset.radioKey === key.radio)
      : host.querySelector(`[${key.attribute}]`);
    target?.focus?.({ preventScroll: true });
  }

  function syncConnection(state) {
    const connected = Boolean(state.connection?.connected);
    const onConnectStep = steps[stepIndex] === 'connect';
    if (connected && !wasConnected && onConnectStep && open && !exiting) {
      view().clearTimeout?.(connectedTimer);
      connectedTimer = view().setTimeout?.(() => { if (open && !exiting && steps[stepIndex] === 'connect') finish('connected'); }, CONNECTED_FINISH_MS);
    }
    wasConnected = connected;
  }

  // Like the startup screen: a pale accent (several light palettes) would
  // draw a near-invisible border and Next tile, so fall back to the text
  // colour when it lacks contrast against the field.
  let paletteKey = '';
  function tuneContrast() {
    const css = view().getComputedStyle?.bind(view());
    if (!css || !parts) return;
    const html = doc.documentElement;
    const key = `${html.dataset.hermesTheme}|${html.dataset.hermesMode}|${html.getAttribute('style') || ''}`;
    if (key === paletteKey) return;
    paletteKey = key;
    host.style.removeProperty('--startup-line');
    host.style.removeProperty('--startup-line-rgb');
    const probe = parts.probe;
    const colorOf = (value) => { probe.style.color = value; return css(probe).color; };
    const ratio = contrastRatio(colorOf('var(--startup-line)'), colorOf('var(--startup-bg)'));
    if (ratio < 3) {
      host.style.setProperty('--startup-line', 'var(--startup-fg)');
      host.style.setProperty('--startup-line-rgb', 'var(--startup-fg-rgb)');
    }
    host.classList.toggle('startup-quiet-accent', ratio < 4.5);
  }

  function buildMeander() {
    const svg = parts?.meander;
    const width = Math.round(host.clientWidth || 0);
    const height = Math.round(host.clientHeight || 0);
    if (!svg || width < 120 || height < 160) return;
    const key = `${width}x${height}`;
    if (key !== meanderSize || !meanderParts) {
      meanderSize = key;
      const geometry = meanderGeometry(width, height, { inset: 6, cell: 1.6, unitWidth: 16 });
      const ns = 'http://www.w3.org/2000/svg';
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.textContent = '';
      const ghost = doc.createElementNS(ns, 'path');
      ghost.setAttribute('class', 'startup-meander-ghost');
      ghost.setAttribute('d', geometry.d);
      const line = doc.createElementNS(ns, 'path');
      line.setAttribute('class', 'startup-meander-line');
      line.setAttribute('d', geometry.d);
      line.style.strokeDasharray = `${geometry.total.toFixed(1)} ${geometry.total.toFixed(1)}`;
      svg.append(ghost, line);
      meanderParts = { line, total: geometry.total };
    }
    paintMeander();
  }

  // The border is the setup's progress: a step's share of the loop, and the
  // whole loop once setup is done.
  function paintMeander(fraction = exiting ? 1 : (stepIndex + 1) / (steps.length + 1)) {
    if (!meanderParts) return;
    meanderParts.line.style.strokeDashoffset = (meanderParts.total * (1 - fraction)).toFixed(1);
  }

  function render() {
    if (!host) return;
    if (!open) {
      if (!exiting) {
        host.hidden = true;
        host.classList.remove('is-entering');
        host.innerHTML = '';
        parts = null;
        paletteKey = '';
        meanderParts = null;
        meanderSize = '';
        previewKey = '';
      }
      return;
    }
    host.hidden = false;
    const state = getState() || {};
    const keep = focusKey();
    // A new language redraws the shell too: Skip and the nav's name were drawn
    // once, in the old language.
    const localeKey = String(state.language?.current || '');
    if (parts && localeKey !== shellLocale) {
      host.innerHTML = '';
      parts = null;
      meanderParts = null;
      meanderSize = '';
      previewKey = '';
      paletteKey = '';
    }
    shellLocale = localeKey;
    if (!parts) {
      host.innerHTML = shellHtml();
      parts = {
        meander: host.querySelector('.onboarding-meander'),
        logo: host.querySelector('.onboarding-logo'),
        progress: host.querySelector('.onboarding-progress'),
        count: host.querySelector('.onboarding-count'),
        preview: host.querySelector('.onboarding-preview'),
        stage: host.querySelector('.onboarding-stage'),
        nav: host.querySelector('.onboarding-nav'),
        back: host.querySelector('[data-onboarding-back]'),
        next: host.querySelector('[data-onboarding-next]'),
        announce: host.querySelector('.onboarding-announce'),
        probe: host.querySelector('.onboarding-probe'),
      };
    }
    const step = steps[stepIndex];
    host.classList.toggle('is-approving', Boolean(approvalNode) && step === 'connect');
    renderMeta(step);
    renderStage(step, state);
    renderNav(step, state);
    renderPreview(state);
    restoreFocus(keep);
    syncConnection(state);
    tuneContrast();
    buildMeander();
  }

  function announce() {
    if (!parts) return;
    parts.announce.textContent = `${t('onboarding.step_count', { current: stepIndex + 1, total: steps.length })}: ${t(`onboarding.${steps[stepIndex]}.title`)}`;
  }

  // The language list is long: arriving on the step brings the card in force
  // (the suggestion, or the saved language) into view.
  function revealSelectedLanguage() {
    if (steps[stepIndex] !== 'language') return;
    parts?.stage.querySelector('[role="radio"][aria-checked="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }

  function focusTitle() {
    host?.querySelector('.onboarding-title')?.focus({ preventScroll: true });
  }

  function go(index) {
    const next = Math.max(0, Math.min(steps.length - 1, index));
    if (next === stepIndex) return;
    const direction = next > stepIndex ? 'next' : 'back';
    onLeaveStep(steps[stepIndex]);
    stepIndex = next;
    render();
    if (parts) {
      parts.stage.dataset.direction = direction;
      replay(parts.stage, 'is-switching');
    }
    announce();
    focusTitle();
    revealSelectedLanguage();
  }

  // From the logo's place on the startup screen to its small place at the top.
  function flyLogo(origin) {
    const logo = parts?.logo;
    if (!origin || !logo?.animate || reducedMotion()) return;
    const target = logo.getBoundingClientRect();
    if (!target.width || !origin.width) return;
    const dx = origin.left + origin.width / 2 - (target.left + target.width / 2);
    const dy = origin.top + origin.height / 2 - (target.top + target.height / 2);
    const scale = origin.width / target.width;
    logo.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
      { transform: 'none' },
    ], { duration: 720, easing: 'cubic-bezier(0.3, 0.7, 0.2, 1)' });
  }

  // The way out: the border closes its loop, then the whole screen dithers
  // away while the panel's own chrome comes in underneath (onReveal).
  async function finish(reason) {
    if (!open || exiting) return;
    view().clearTimeout?.(connectedTimer);
    onLeaveStep(steps[stepIndex]);
    open = false;
    exiting = true;
    host.classList.add('is-finishing');
    paintMeander(1);
    onFinish({ reason });
    const still = reducedMotion();
    if (!still) await wait(560);
    host.classList.add('is-exiting');
    onReveal({ reason });
    await wait(still ? 220 : 720);
    exiting = false;
    host.classList.remove('is-finishing', 'is-exiting');
    render();
    onExited({ reason });
  }

  function next() {
    if (stepIndex === steps.length - 1) void finish(steps[stepIndex] === 'connect' && !getState()?.connection?.connected ? 'later' : 'done');
    else go(stepIndex + 1);
  }

  function choose(select, value) {
    select(value);
    render();
  }

  host?.addEventListener('click', (event) => {
    const target = event.target?.closest?.('button');
    if (!open || exiting || !target || !host.contains(target)) return;
    const data = target.dataset;
    if (data.onboardingLanguage) return choose(onSelectLanguage, data.onboardingLanguage);
    if (data.onboardingTheme) return choose(onSelectTheme, data.onboardingTheme);
    if (data.onboardingMode) return choose(onSelectMode, data.onboardingMode);
    if (data.onboardingFont) return choose(onSelectFont, data.onboardingFont);
    if (data.onboardingStyle) return choose(onSelectStyle, data.onboardingStyle);
    if (data.onboardingLayout) return choose(onSelectLayout, data.onboardingLayout);
    if (target.hasAttribute('data-onboarding-connect')) return onConnect();
    if (target.hasAttribute('data-onboarding-manual')) return onManualSetup();
    if (target.hasAttribute('data-onboarding-back')) return go(stepIndex - 1);
    if (target.hasAttribute('data-onboarding-skip')) return void finish('skip');
    if (target.hasAttribute('data-onboarding-next')) return next();
    return undefined;
  });

  const isRtl = () => {
    const direction = host?.closest?.('[dir]')?.getAttribute('dir') || host?.ownerDocument?.documentElement?.getAttribute('dir') || '';
    return direction.toLowerCase() === 'rtl';
  };

  // Radio groups keep their arrow keys; elsewhere Left and Right turn the
  // page. Tab stays inside the screen while it is up.
  host?.addEventListener('keydown', (event) => {
    if (!open || exiting) return;
    if (handleRadioCardKeydown(event, host)) return;
    const target = event.target;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '') || target?.isContentEditable;
    if (!typing && (event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      // The arrow that points toward the Next button: Right in left-to-right text, Left in right-to-left.
      const forwardKey = isRtl() ? 'ArrowLeft' : 'ArrowRight';
      if (event.key === forwardKey) next();
      else go(stepIndex - 1);
      return;
    }
    if (event.key === 'Tab') {
      const focusable = [...host.querySelectorAll('button:not([disabled])')].filter((node) => node.tabIndex >= 0 && !node.closest('[hidden]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (target === first || !host.contains(target))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && target === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  // A horizontal swipe turns the page; vertical movement scrolls as usual.
  let swipe = null;
  host?.addEventListener('pointerdown', (event) => {
    swipe = open && !exiting && event.isPrimary !== false ? { x: event.clientX, y: event.clientY } : null;
  });
  host?.addEventListener('pointerup', (event) => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    // Dragging toward the start of the line goes forward: left in LTR, right in RTL.
    if (isRtl() ? dx > 0 : dx < 0) next();
    else go(stepIndex - 1);
  });
  host?.addEventListener('pointercancel', () => { swipe = null; });

  const ResizeObserverCtor = view().ResizeObserver;
  if (host && typeof ResizeObserverCtor === 'function') {
    new ResizeObserverCtor(() => { if (open || exiting) buildMeander(); }).observe(host);
  }

  return {
    get isOpen() { return open; },
    get isExiting() { return exiting; },
    get step() { return steps[stepIndex]; },
    get steps() { return [...steps]; },
    open({ step = 'language', includeConnect = true, origin = null } = {}) {
      steps = onboardingSteps({ includeConnect });
      stepIndex = Math.max(0, steps.indexOf(step));
      open = true;
      exiting = false;
      wasConnected = Boolean(getState()?.connection?.connected);
      render();
      replay(host, 'is-entering');
      flyLogo(origin);
      announce();
      focusTitle();
      revealSelectedLanguage();
    },
    close() {
      view().clearTimeout?.(connectedTimer);
      open = false;
      exiting = false;
      render();
    },
    // Show the pairing approval page in the Connect step (a node), or take it
    // away (null). Returns whether the step is on screen to hold it.
    setApproval(node = null) {
      approvalNode = node || null;
      if (!open || !parts) return false;
      if (!approvalNode && parts.stage.dataset.step === 'connect') parts.stage.dataset.step = '';
      render();
      return Boolean(approvalNode) && steps[stepIndex] === 'connect' && parts.stage.contains(approvalNode);
    },
    finish,
    render,
  };
}

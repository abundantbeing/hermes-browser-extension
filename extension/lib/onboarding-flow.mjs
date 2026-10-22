// First-run setup: theme, response style, chat layout, then a finish step.
// Every choice applies live through the callbacks (the same code paths the
// Settings controls use), so leaving the flow early keeps what was picked.
// DOM only through the host and document passed in; no storage here.

import { escapeHtml } from './common.mjs';
import { MESSAGE_LAYOUTS, RESPONSE_STYLES } from './response-presentation.mjs';

export const ONBOARDING_STEPS = Object.freeze(['theme', 'style', 'layout', 'finish']);

const STYLE_COPY = Object.freeze({
  vivid: { title: 'responses.style.vivid', hint: 'responses.style.vivid_hint' },
  rich: { title: 'responses.style.rich', hint: 'responses.style.rich_hint' },
  plain: { title: 'responses.style.plain', hint: 'responses.style.plain_hint' },
});

const LAYOUT_COPY = Object.freeze({
  bubbles: { title: 'responses.layout.bubbles', hint: 'responses.layout.bubbles_hint' },
  'user-bubble': { title: 'responses.layout.user_bubble', hint: 'responses.layout.user_bubble_hint' },
});

export function responseStyleLabelKey(style) {
  return STYLE_COPY[style]?.title || STYLE_COPY.rich.title;
}

export function messageLayoutLabelKey(layout) {
  return LAYOUT_COPY[layout]?.title || LAYOUT_COPY.bubbles.title;
}

// Small drawn previews: no text, so they read the same in every language.
function stylePreview(style) {
  if (style === 'vivid') {
    return '<span class="onboarding-preview preview-vivid" aria-hidden="true"><i class="pv-stat"></i><i class="pv-stat"></i><i class="pv-bars"><b></b><b></b><b></b><b></b></i></span>';
  }
  if (style === 'plain') {
    return '<span class="onboarding-preview preview-plain" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
  }
  return '<span class="onboarding-preview preview-rich" aria-hidden="true"><i class="pv-head"></i><i class="pv-bullet"></i><i class="pv-bullet"></i><i class="pv-code"></i></span>';
}

function layoutPreview(layout) {
  const reply = layout === 'user-bubble'
    ? '<i class="pv-reply-flow"></i><i class="pv-reply-flow short"></i>'
    : '<i class="pv-reply-bubble"></i>';
  return `<span class="onboarding-preview preview-layout preview-${layout}" aria-hidden="true"><i class="pv-user-bubble"></i>${reply}<i class="pv-user-bubble short"></i></span>`;
}

function optionCard({ group, value, selected, title, hint, preview }) {
  return `
    <button type="button" class="onboarding-option${selected ? ' selected' : ''}" role="radio" aria-checked="${selected}" data-onboarding-${group}="${escapeHtml(value)}">
      ${preview}
      <span class="onboarding-option-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(hint)}</small></span>
    </button>`;
}

function themeCard(theme, selected) {
  const p = theme.preview || {};
  const style = `--preview-bg:${p.bg};--preview-panel:${p.panel};--preview-text:${p.text};--preview-muted:${p.muted};--preview-accent:${p.accent};`;
  return `
    <button class="theme-card${selected ? ' selected' : ''}" type="button" data-onboarding-theme="${escapeHtml(theme.value)}" role="radio" aria-checked="${selected}" aria-label="${escapeHtml(theme.name)}" title="${escapeHtml(`${theme.name}: ${theme.description || ''}`)}" style="${escapeHtml(style)}">
      <span class="theme-preview" aria-hidden="true"><span></span><span></span><span></span></span>
      <span class="theme-card-copy"><strong>${escapeHtml(theme.name)}</strong></span>
      <span class="theme-check" aria-hidden="true">${selected ? '✓' : ''}</span>
    </button>`;
}

export function createOnboardingFlow({
  host,
  themes = [],
  translate = (key) => key,
  getState = () => ({}),
  onSelectTheme = () => {},
  onSelectStyle = () => {},
  onSelectLayout = () => {},
  onFinish = () => {},
} = {}) {
  let stepIndex = 0;
  let open = false;
  const t = (key, values) => translate(key, values);

  function stepBody(step, state) {
    if (step === 'theme') {
      const cards = themes.map((theme) => themeCard(theme, theme.value === state.theme)).join('');
      return `<div class="theme-grid onboarding-theme-grid" role="radiogroup" aria-label="${escapeHtml(t('onboarding.theme.title'))}">${cards}</div>`;
    }
    if (step === 'style') {
      const cards = RESPONSE_STYLES.map((style) => optionCard({
        group: 'style', value: style, selected: style === state.responseStyle,
        title: t(STYLE_COPY[style].title), hint: t(STYLE_COPY[style].hint), preview: stylePreview(style),
      })).join('');
      return `<div class="onboarding-options" role="radiogroup" aria-label="${escapeHtml(t('onboarding.style.title'))}">${cards}</div>`;
    }
    if (step === 'layout') {
      const cards = MESSAGE_LAYOUTS.map((layout) => optionCard({
        group: 'layout', value: layout, selected: layout === state.messageLayout,
        title: t(LAYOUT_COPY[layout].title), hint: t(LAYOUT_COPY[layout].hint), preview: layoutPreview(layout),
      })).join('');
      return `<div class="onboarding-options" role="radiogroup" aria-label="${escapeHtml(t('onboarding.layout.title'))}">${cards}</div>`;
    }
    const themeName = themes.find((theme) => theme.value === state.theme)?.name || state.theme || '';
    const rows = [
      [t('onboarding.summary.theme'), themeName],
      [t('onboarding.summary.style'), t(responseStyleLabelKey(state.responseStyle))],
      [t('onboarding.summary.layout'), t(messageLayoutLabelKey(state.messageLayout))],
    ].map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    return `<dl class="onboarding-summary">${rows}</dl>`;
  }

  function render() {
    if (!host) return;
    host.hidden = !open;
    if (!open) {
      host.innerHTML = '';
      return;
    }
    const step = ONBOARDING_STEPS[stepIndex];
    const state = getState() || {};
    const last = stepIndex === ONBOARDING_STEPS.length - 1;
    const dots = ONBOARDING_STEPS.map((_, index) => `<i class="${index === stepIndex ? 'active' : ''}${index < stepIndex ? ' done' : ''}"></i>`).join('');
    host.dataset.step = step;
    host.innerHTML = `
      <div class="onboarding-head">
        <span class="onboarding-progress" aria-hidden="true">${dots}</span>
        <span class="onboarding-count">${escapeHtml(t('onboarding.step_count', { current: stepIndex + 1, total: ONBOARDING_STEPS.length }))}</span>
        ${last ? '' : `<button type="button" class="onboarding-skip secondary" data-onboarding-skip>${escapeHtml(t('onboarding.skip'))}</button>`}
      </div>
      <h2 class="onboarding-title" tabindex="-1">${escapeHtml(t(`onboarding.${step}.title`))}</h2>
      <p class="onboarding-body">${escapeHtml(t(`onboarding.${step}.body`))}</p>
      ${stepBody(step, state)}
      <div class="onboarding-nav">
        ${stepIndex > 0 ? `<button type="button" class="secondary" data-onboarding-back>${escapeHtml(t('onboarding.back'))}</button>` : '<span></span>'}
        <button type="button" class="onboarding-next" data-onboarding-next>${escapeHtml(t(last ? 'onboarding.start' : 'onboarding.next'))}</button>
      </div>`;
  }

  function focusTitle() {
    host?.querySelector('.onboarding-title')?.focus({ preventScroll: true });
  }

  function go(index) {
    stepIndex = Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, index));
    render();
    focusTitle();
  }

  function finish(reason) {
    open = false;
    render();
    onFinish({ reason });
  }

  host?.addEventListener('click', (event) => {
    const target = event.target?.closest?.('button');
    if (!target || !host.contains(target)) return;
    if (target.dataset.onboardingTheme) {
      onSelectTheme(target.dataset.onboardingTheme);
      render();
      return;
    }
    if (target.dataset.onboardingStyle) {
      onSelectStyle(target.dataset.onboardingStyle);
      render();
      return;
    }
    if (target.dataset.onboardingLayout) {
      onSelectLayout(target.dataset.onboardingLayout);
      render();
      return;
    }
    if (target.hasAttribute('data-onboarding-back')) go(stepIndex - 1);
    else if (target.hasAttribute('data-onboarding-skip')) finish('skip');
    else if (target.hasAttribute('data-onboarding-next')) {
      if (stepIndex === ONBOARDING_STEPS.length - 1) finish('done');
      else go(stepIndex + 1);
    }
  });

  return {
    get isOpen() { return open; },
    get step() { return ONBOARDING_STEPS[stepIndex]; },
    open({ step = 'theme' } = {}) {
      open = true;
      stepIndex = Math.max(0, ONBOARDING_STEPS.indexOf(step));
      render();
      focusTitle();
    },
    close() {
      open = false;
      render();
    },
    render,
  };
}

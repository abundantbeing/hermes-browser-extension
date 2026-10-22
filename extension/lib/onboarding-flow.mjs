// First-run setup: theme, response style, chat layout, then a finish step.
// Every choice applies live through the callbacks (the same code paths the
// Settings controls use), so leaving the flow early keeps what was picked.
// DOM only through the host and document passed in; no storage here.

import { escapeHtml } from './common.mjs';
import { handleRadioCardKeydown, presentationCardsHtml, presentationOptionLabelKey } from './presentation-previews.mjs';

export const ONBOARDING_STEPS = Object.freeze(['theme', 'style', 'layout', 'finish']);

export function responseStyleLabelKey(style) {
  return presentationOptionLabelKey('style', style);
}

export function messageLayoutLabelKey(layout) {
  return presentationOptionLabelKey('layout', layout);
}

function themeCard(theme, selected) {
  const p = theme.preview || {};
  const style = `--preview-bg:${p.bg};--preview-panel:${p.panel};--preview-text:${p.text};--preview-muted:${p.muted};--preview-accent:${p.accent};`;
  return `
    <button class="theme-card${selected ? ' selected' : ''}" type="button" data-onboarding-theme="${escapeHtml(theme.value)}" data-radio-key="${escapeHtml(`theme:${theme.value}`)}" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" aria-label="${escapeHtml(theme.name)}" title="${escapeHtml(`${theme.name}: ${theme.description || ''}`)}" style="${escapeHtml(style)}">
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
    // The same visual cards Settings shows, so setup and Settings match.
    if (step === 'style') {
      const cards = presentationCardsHtml('style', { selected: state.responseStyle, attribute: 'data-onboarding-style', translate: t });
      return `<div class="presentation-choices onboarding-options" role="radiogroup" aria-label="${escapeHtml(t('onboarding.style.title'))}">${cards}</div>`;
    }
    if (step === 'layout') {
      const cards = presentationCardsHtml('layout', { selected: state.messageLayout, attribute: 'data-onboarding-layout', translate: t });
      return `<div class="presentation-choices onboarding-options" role="radiogroup" aria-label="${escapeHtml(t('onboarding.layout.title'))}">${cards}</div>`;
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

  // A choice re-renders the step; focus stays on the card that was chosen.
  function choose(select, value, key) {
    select(value);
    render();
    [...host.querySelectorAll('[data-radio-key]')].find((node) => node.dataset.radioKey === key)?.focus({ preventScroll: true });
  }

  host?.addEventListener('click', (event) => {
    const target = event.target?.closest?.('button');
    if (!target || !host.contains(target)) return;
    if (target.dataset.onboardingTheme) {
      choose(onSelectTheme, target.dataset.onboardingTheme, target.dataset.radioKey);
      return;
    }
    if (target.dataset.onboardingStyle) {
      choose(onSelectStyle, target.dataset.onboardingStyle, target.dataset.radioKey);
      return;
    }
    if (target.dataset.onboardingLayout) {
      choose(onSelectLayout, target.dataset.onboardingLayout, target.dataset.radioKey);
      return;
    }
    if (target.hasAttribute('data-onboarding-back')) go(stepIndex - 1);
    else if (target.hasAttribute('data-onboarding-skip')) finish('skip');
    else if (target.hasAttribute('data-onboarding-next')) {
      if (stepIndex === ONBOARDING_STEPS.length - 1) finish('done');
      else go(stepIndex + 1);
    }
  });

  host?.addEventListener('keydown', (event) => handleRadioCardKeydown(event, host));

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

// Meander startup screen: a Greek key border that draws itself around the
// panel as the readiness progress bar, with the current check's count, state,
// name and detail in the middle. sidepanel.js owns when the screen shows; this
// module only paints it from deriveStartupView().

import { createLogoVeil } from './startup-logo-veil.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const GREEK = ['Α', 'Β', 'Γ', 'Δ', 'Ε', 'Ζ', 'Η', 'Θ', 'Ι', 'Κ', 'Λ', 'Μ', 'Ν', 'Ξ', 'Ο', 'Π'];

// One meander unit on a 10 x 8 grid; y = 8 is the continuous outer line.
const KEY_UNIT = Object.freeze([[0, 8], [0, 0], [8, 0], [8, 6], [4, 6], [4, 4], [6, 4], [6, 2], [2, 2], [2, 8], [10, 8]]);

// A line for each check while it has nothing more specific to say.
export const STARTUP_STEP_LINES = Object.freeze({
  settings: 'Reading the scrolls',
  gateway: 'Opening the gates',
  capabilities: 'Arming the messenger',
  models: 'Consulting the oracles',
  selectedModel: 'Choosing an oracle',
  skills: 'Gathering the arts',
  profiles: 'Calling the pantheon',
  sessions: 'Recalling past journeys',
  sessionBinding: 'Binding the golden thread',
});

const FAILED_STATUSES = new Set(['error', 'unreachable', 'unconfigured']);
const pad = (n) => String(n).padStart(2, '0');

/**
 * The Greek key path around a width x height box. Each edge holds a whole
 * number of units, stretched slightly to fit, so the corners always meet.
 */
export function meanderGeometry(width, height, { inset = 12, cell = 2.2, unitWidth = 22 } = {}) {
  const x0 = inset;
  const y0 = inset;
  const x1 = Math.max(x0 + 60, width - inset);
  const y1 = Math.max(y0 + 60, height - inset);
  const band = 8 * cell;
  const points = [];
  const cornerIndex = [];
  const edge = (length, map) => {
    const units = Math.max(1, Math.round(length / unitWidth));
    const w = length / units;
    for (let u = 0; u < units; u += 1) {
      KEY_UNIT.forEach(([ux, uy], i) => {
        if (u > 0 && i === 0) return;
        points.push(map(((ux + 10 * u) * w) / 10, (8 - uy) * cell));
      });
    }
  };
  points.push([x0, y0 + band]);
  cornerIndex.push(points.length);
  points.push([x0, y0]);
  edge(x1 - x0 - 2 * band, (u, v) => [x0 + band + u, y0 + v]);
  cornerIndex.push(points.length);
  points.push([x1, y0]);
  edge(y1 - y0 - 2 * band, (u, v) => [x1 - v, y0 + band + u]);
  cornerIndex.push(points.length);
  points.push([x1, y1]);
  edge(x1 - x0 - 2 * band, (u, v) => [x1 - band - u, y1 - v]);
  cornerIndex.push(points.length);
  points.push([x0, y1]);
  edge(y1 - y0 - 2 * band, (u, v) => [x0 + v, y1 - band - u]);

  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) {
    lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = lengths[lengths.length - 1];
  return {
    d: `M${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}`,
    total,
    band,
    frame: { x0, y0, x1, y1 },
    corners: [[x0, y0], [x1 - band, y0], [x1 - band, y1 - band], [x0, y1 - band]],
    cornerFractions: cornerIndex.map((i) => lengths[i] / total),
  };
}

/** What the screen says for a readiness view: count, state, label, detail and progress. */
export function startupScreenModel(view, translate = (text) => text) {
  const steps = Array.isArray(view?.steps) ? view.steps : [];
  const total = Math.max(steps.length, 1);
  const failedIndex = steps.findIndex((step) => FAILED_STATUSES.has(step.status));
  const activeIndex = steps.findIndex((step) => step.status === 'active' || step.status === 'pending');
  const tone = view?.ready
    ? 'ready'
    : view?.phase === 'setup-needed'
      ? 'setup'
      : view?.errored || view?.phase === 'error'
        ? 'error'
        : 'loading';
  // A failed or unconfigured check is where the screen stops, so it names that one.
  const focus = (tone === 'error' || tone === 'setup') && failedIndex >= 0
    ? failedIndex
    : activeIndex >= 0 ? activeIndex : total - 1;
  const step = steps[focus] || {};
  const completed = Math.max(0, Math.min(100, Number(view?.progress) || 0)) / 100;

  let label = translate(step.label || view?.title || '');
  let detail = translate(view?.detail || '');
  if (tone === 'ready' || tone === 'setup') label = translate(view?.title || label);
  if (tone === 'error' && failedIndex >= 0) {
    const reason = step.status === 'unreachable' ? 'unreachable' : step.status === 'unconfigured' ? 'not set up' : 'failed';
    label = `${translate(step.label || '')} ${translate(reason)}`.trim();
  }
  // The real reason beats the generic line: the status card it points to is
  // still behind this screen.
  if ((tone === 'error' || tone === 'setup') && step.detail) detail = translate(step.detail);
  if (tone === 'loading' && !step.detail) {
    detail = translate(STARTUP_STEP_LINES[step.key] || view?.detail || '');
  }

  const state = { loading: 'Connecting', setup: 'Not connected', error: 'Needs attention', ready: 'Ready' }[tone];
  return {
    tone,
    count: tone === 'ready' ? `${pad(total)} / ${pad(total)}` : `${GREEK[focus] || ''} · ${pad(focus + 1)} / ${pad(total)}`,
    state: translate(state),
    label,
    detail,
    progress: tone === 'ready' ? 1 : Math.min(1, completed + (tone === 'loading' ? 0.45 / total : 0)),
  };
}

// WCAG relative luminance contrast between two rgb()/rgba() colours.
export function contrastRatio(a, b) {
  const luminance = (color) => {
    const [r, g, bl] = (String(color).match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function svgEl(tag, attrs, parent) {
  const el = parent.ownerDocument.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  parent.append(el);
  return el;
}

// The Hermes desktop app's default GlyphSpinner (unicode-animations "braille"),
// so a check in progress reads the same here as it does there.
export const STARTUP_SPINNER = Object.freeze({
  frames: Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']),
  interval: 80,
});
export const STARTUP_SPINNER_STILL = '⠿';

/**
 * Drives the glyph in front of the state label through a CSS custom property,
 * so swapping the label's text never touches it. sync(true) starts it,
 * sync(false) clears the timer and the glyph; reduced motion gets a still one.
 */
export function createStateSpinner(target, {
  setInterval: every = globalThis.setInterval?.bind(globalThis),
  clearInterval: cancel = globalThis.clearInterval?.bind(globalThis),
  reducedMotion = () => false,
} = {}) {
  let timer = null;
  let frame = 0;
  const show = (glyph) => target?.style?.setProperty('--startup-glyph', `"${glyph}"`);
  const stop = () => {
    if (timer !== null) cancel?.(timer);
    timer = null;
    frame = 0;
    target?.style?.removeProperty('--startup-glyph');
  };
  return {
    sync(active) {
      if (!active || !target) {
        stop();
        return;
      }
      if (reducedMotion()) {
        if (timer !== null) cancel?.(timer);
        timer = null;
        show(STARTUP_SPINNER_STILL);
        return;
      }
      if (timer !== null || !every) return;
      show(STARTUP_SPINNER.frames[frame]);
      timer = every(() => {
        frame = (frame + 1) % STARTUP_SPINNER.frames.length;
        show(STARTUP_SPINNER.frames[frame]);
      }, STARTUP_SPINNER.interval);
    },
    stop,
    get running() { return timer !== null; },
  };
}

// True when a button shows its own name: text that is neither an icon, hidden
// from view (sr-only) nor hidden from assistive tech.
export function hasVisibleLabel(button) {
  for (const node of button?.childNodes || []) {
    if (node.nodeType === 3) {
      if (node.textContent.trim()) return true;
      continue;
    }
    if (node.nodeType !== 1) continue;
    if (String(node.tagName).toLowerCase() === 'svg') continue;
    if (node.classList?.contains('sr-only') || node.getAttribute?.('aria-hidden') === 'true') continue;
    if (node.textContent.trim()) return true;
  }
  return false;
}

// Swap text with a short fade so each check reads as a new line, not a flicker.
function swapText(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('startup-swap');
  void el.offsetWidth;
  el.classList.add('startup-swap');
}

/**
 * Paints the startup screen. `parts` are the elements in sidepanel.html; the
 * returned render(view) is safe to call on every readiness change.
 */
export function createStartupScreen({ root, meander, count, state, label, detail, stepList, actions, translate = (t) => t }) {
  const doc = root.ownerDocument;
  // The border and the HERMES backdrop are decoration, so they are built here
  // rather than sitting in the page markup next to the real icons.
  const back = doc.createElementNS(SVG_NS, 'svg');
  back.setAttribute('class', 'startup-backtype');
  back.setAttribute('viewBox', '0 0 340 150');
  back.setAttribute('preserveAspectRatio', 'xMidYMax meet');
  back.setAttribute('aria-hidden', 'true');
  svgEl('text', { x: 170, y: 262, 'text-anchor': 'middle', textLength: 344, lengthAdjust: 'spacingAndGlyphs' }, back).textContent = 'HERMES';
  root.prepend(back);
  const veil = createLogoVeil(root.querySelector('.startup-brand-icon'));
  const spinner = createStateSpinner(state, {
    setInterval: doc.defaultView?.setInterval?.bind(doc.defaultView),
    clearInterval: doc.defaultView?.clearInterval?.bind(doc.defaultView),
    reducedMotion: () => Boolean(doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
  });
  if (!meander) {
    meander = doc.createElementNS(SVG_NS, 'svg');
    meander.setAttribute('class', 'startup-meander');
    meander.setAttribute('aria-hidden', 'true');
    root.prepend(meander);
  }
  let geometry = null;
  let size = '';
  let progress = 0;
  let headFrom = 0;
  let headTo = 0;
  let headStart = 0;
  let frame = 0;
  let settle = 0;
  let parts = null;
  const HEAD_MS = 900;

  const build = () => {
    const width = Math.round(root.clientWidth);
    const height = Math.round(root.clientHeight);
    if (!meander || width < 120 || height < 160) return false;
    const key = `${width}x${height}`;
    if (key === size && parts) return true;
    size = key;
    geometry = meanderGeometry(width, height);
    meander.setAttribute('viewBox', `0 0 ${width} ${height}`);
    meander.textContent = '';
    const { x0, y0, x1, y1 } = geometry.frame;
    const band = geometry.band;
    svgEl('rect', { class: 'startup-meander-rule', x: x0 - 4, y: y0 - 4, width: x1 - x0 + 8, height: y1 - y0 + 8 }, meander);
    svgEl('rect', { class: 'startup-meander-rule', x: x0 + band + 4, y: y0 + band + 4, width: x1 - x0 - 2 * band - 8, height: y1 - y0 - 2 * band - 8 }, meander);
    svgEl('path', { class: 'startup-meander-ghost', d: geometry.d }, meander);
    const line = svgEl('path', { class: 'startup-meander-line', d: geometry.d }, meander);
    line.style.strokeDasharray = `${geometry.total.toFixed(1)} ${geometry.total.toFixed(1)}`;
    const corners = geometry.corners.map(([x, y]) => {
      const g = svgEl('g', { class: 'startup-meander-corner' }, meander);
      svgEl('rect', { x: x + 4, y: y + 4, width: band - 8, height: band - 8 }, g);
      svgEl('rect', { x: x + band / 2 - 1.5, y: y + band / 2 - 1.5, width: 3, height: 3 }, g);
      return g;
    });
    const head = svgEl('circle', { class: 'startup-meander-head', r: 2.6, cx: x0, cy: y0 + band }, meander);
    parts = { line, corners, head };
    paint(progress, true);
    return true;
  };

  const placeHead = (fraction) => {
    if (!parts || !geometry) return;
    const point = parts.line.getPointAtLength(geometry.total * fraction);
    parts.head.setAttribute('cx', point.x.toFixed(1));
    parts.head.setAttribute('cy', point.y.toFixed(1));
  };

  // The line itself eases by CSS; the head follows on a time-based tween so a
  // skipped frame never strands it behind the line.
  const paint = (fraction, instant = false) => {
    if (!parts || !geometry) return;
    parts.line.style.strokeDashoffset = (geometry.total * (1 - fraction)).toFixed(1);
    parts.corners.forEach((g, i) => g.classList.toggle('is-lit', fraction > 0 && fraction >= geometry.cornerFractions[i] - 0.0005));
    const view = root.ownerDocument.defaultView;
    view?.cancelAnimationFrame?.(frame);
    view?.clearTimeout?.(settle);
    if (instant || !view?.requestAnimationFrame) {
      headFrom = headTo = fraction;
      placeHead(fraction);
      return;
    }
    const now = view.performance.now();
    const at = (t) => {
      const k = Math.max(0, Math.min(1, (t - headStart) / HEAD_MS));
      return headFrom + (headTo - headFrom) * (1 - (1 - k) ** 3);
    };
    headFrom = at(now);
    headTo = fraction;
    headStart = now;
    const step = (t) => {
      placeHead(at(t));
      if (t - headStart < HEAD_MS) frame = view.requestAnimationFrame(step);
    };
    frame = view.requestAnimationFrame(step);
    settle = view.setTimeout(() => placeHead(headTo), HEAD_MS + 120);
  };

  const ResizeObserverCtor = root.ownerDocument.defaultView?.ResizeObserver;
  if (typeof ResizeObserverCtor === 'function') {
    new ResizeObserverCtor(() => { if (!root.hidden) build(); }).observe(root);
  }

  // Icon-only dock buttons show their name in a tooltip; park the native title
  // while the screen is up so the two tooltips never stack. A button that
  // already shows its label gets neither, so the name never reads twice.
  const syncTooltips = (visible) => {
    for (const button of actions?.querySelectorAll?.('button') || []) {
      if (visible) {
        if (button.title) {
          button.dataset.startupTitle = button.title;
          button.removeAttribute('title');
        }
        if (hasVisibleLabel(button)) {
          delete button.dataset.tip;
          continue;
        }
        const tip = button.dataset.startupTitle || button.getAttribute('aria-label') || button.textContent.trim();
        if (tip) button.dataset.tip = tip;
      } else if (button.dataset.startupTitle) {
        button.title = button.dataset.startupTitle;
        delete button.dataset.startupTitle;
      }
    }
  };

  // Themes (and imported custom themes) whose accent is a pale tint would draw
  // a near-invisible key; fall back to the text colour when contrast is low.
  const probe = doc.createElement('i');
  probe.hidden = true;
  root.append(probe);
  let paletteKey = '';
  const tuneContrast = () => {
    const css = doc.defaultView?.getComputedStyle?.bind(doc.defaultView);
    if (!css) return;
    const html = doc.documentElement;
    const key = `${html.dataset.hermesTheme}|${html.dataset.hermesMode}|${html.getAttribute('style') || ''}`;
    if (key === paletteKey) return;
    paletteKey = key;
    root.style.removeProperty('--startup-line');
    root.style.removeProperty('--startup-line-rgb');
    const colorOf = (value) => { probe.style.color = value; return css(probe).color; };
    const line = colorOf('var(--startup-line)');
    const field = colorOf('var(--startup-bg)');
    const ratio = contrastRatio(line, field);
    if (ratio < 3) {
      root.style.setProperty('--startup-line', 'var(--startup-fg)');
      root.style.setProperty('--startup-line-rgb', 'var(--startup-fg-rgb)');
    }
    root.classList.toggle('startup-quiet-accent', ratio < 4.5);
  };

  return {
    render(view) {
      if (view?.visible) tuneContrast();
      const model = startupScreenModel(view, translate);
      root.classList.toggle('is-error', model.tone === 'error');
      root.classList.toggle('is-setup', model.tone === 'setup');
      root.classList.toggle('is-ready', model.tone === 'ready');
      // Only a check still running animates; settled states hold still.
      const loading = Boolean(view?.visible) && model.tone === 'loading';
      root.classList.toggle('is-loading', loading);
      spinner.sync(loading);
      swapText(count, model.count);
      swapText(state, model.state);
      swapText(label, model.label);
      swapText(detail, model.detail);
      if (label) label.title = model.label;
      progress = model.progress;
      if (!root.hidden && build()) paint(progress);
      syncTooltips(Boolean(view?.visible));
      if (!view?.visible) veil.rest();
      if (stepList) {
        stepList.textContent = '';
        for (const step of view?.steps || []) {
          const item = root.ownerDocument.createElement('li');
          item.className = `startup-step startup-step-${step.status}`;
          item.dataset.status = step.status;
          item.textContent = `${translate(step.label)}: ${translate(step.detail || step.status)}`;
          stepList.append(item);
        }
      }
      return model;
    },
  };
}

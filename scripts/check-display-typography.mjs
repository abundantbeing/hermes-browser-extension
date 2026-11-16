/**
 * Fail closed on cramped Rules Gothic / HermesDisplay typography (display headlines).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRACKING_MIN_EM = 0.03;
const LINE_HEIGHT_MIN = 1.2;
const DISPLAY_MARKERS = /var\(\s*--hermes-font-display|--hermes-font-brand|Rules Gothic Compressed|HermesDisplay|"Rules Compressed"/i;
const TRACKING_TOKEN = /var\(\s*--hermes-display-tracking/i;

const CSS_GLOBS = [
  'extension/sidepanel.css',
  'extension/hermes-web-opening.css',
  'extension/lib/branded-select.css',
  'extension/lib/adaptive-ui.css',
  'extension/lib/surface-text-zoom.css',
];

const SKIP_SELECTOR = /@font-face|@keyframes|^\s*@|--hermes-display-tracking|startup-backtype text/i;

export function parseRules(css, fileLabel = '') {
  const rules = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let chunkStart = 0;
  let bodyStart = 0;
  const selectorStack = [];

  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '{') {
      const selector = stripped.slice(chunkStart, i).trim();
      chunkStart = i + 1;
      selectorStack.push(selector);
      bodyStart = i + 1;
      depth += 1;
    } else if (ch === '}') {
      const body = stripped.slice(bodyStart, i).trim();
      const selector = selectorStack.pop() || '';
      depth -= 1;
      if (selector && !SKIP_SELECTOR.test(selector)) {
        const line = (stripped.slice(0, bodyStart).match(/\n/g) || []).length + 1;
        rules.push({ selector, body, line, file: fileLabel });
      }
      chunkStart = i + 1;
      if (depth > 0) bodyStart = i + 1;
    }
  }
  return rules;
}

export function emValue(raw = '') {
  const match = String(raw).trim().match(/^(-?[\d.]+)em$/i);
  return match ? Number(match[1]) : null;
}

function declarations(body) {
  return String(body)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function lastDeclaration(body, property) {
  const key = String(property).toLowerCase();
  for (let i = declarations(body).length - 1; i >= 0; i -= 1) {
    const decl = declarations(body)[i];
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    if (decl.slice(0, colon).trim().toLowerCase() === key) {
      return decl.slice(colon + 1).trim();
    }
  }
  return '';
}

export function fontShorthandParts(fontDecl = '') {
  const font = String(fontDecl).trim();
  let depth = 0;
  for (let i = 0; i < font.length; i += 1) {
    const ch = font[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === '/' && depth === 0) {
      return {
        before: font.slice(0, i).trim(),
        lhRaw: font.slice(i + 1).trim().split(/\s+/)[0] || '',
      };
    }
  }
  return { before: font, lhRaw: '' };
}

function simpleCalcPx(expr = '') {
  const text = String(expr).trim();
  const m = text.match(/^calc\(\s*([\d.]+)px\s*([+\-*/])\s*([\d.]+)(?:px)?\s*\)$/i);
  if (!m) return null;
  const a = Number(m[1]);
  const op = m[2];
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  if (op === '/') return b !== 0 ? a / b : null;
  return null;
}

function evalCalcPx(expr = '') {
  const text = String(expr).trim();
  const inner = text.match(/^calc\(\s*(.+)\s*\)$/i)?.[1];
  if (!inner) return null;
  if (/var\(|clamp\(/i.test(inner)) return null;

  const single = simpleCalcPx(text);
  if (single != null) return single;

  const tokens = inner.split(/\s+/).filter(Boolean);
  if (tokens.length < 3 || tokens.length % 2 === 0) return null;
  let result = null;
  for (let i = 0; i < tokens.length; i += 2) {
    const term = tokens[i];
    const px = term.match(/^([\d.]+)px$/i);
    const unitless = !px && /^[\d.]+$/.test(term) ? term : null;
    const n = px ? Number(px[1]) : unitless ? Number(unitless) : null;
    if (n == null || !Number.isFinite(n)) return null;
    if (result == null) {
      result = n;
      continue;
    }
    const op = tokens[i - 1];
    if (op === '+') result += n;
    else if (op === '-') result -= n;
    else return null;
  }
  return result;
}

export function fontSizePxFromShorthandBefore(before = '') {
  const text = String(before).trim();
  if (!text) return null;
  const tokens = text.split(/\s+/);
  const sizeToken = tokens[tokens.length - 1] || '';
  if (/^[\d.]+px$/i.test(sizeToken)) {
    return Number(sizeToken.match(/^([\d.]+)px$/i)[1]);
  }
  const calcOnly = sizeToken.match(/^(calc\([^)]*\))$/i)?.[1]
    || text.match(/(calc\([^)]*\))/i)?.[1];
  if (calcOnly) {
    const px = evalCalcPx(calcOnly);
    if (px != null) return px;
    if (/var\(|clamp\(/i.test(calcOnly)) return null;
    return null;
  }
  if (text.includes('calc(')) return null;
  const simple = text.match(/([\d.]+)px/i);
  return simple ? Number(simple[1]) : null;
}

export function lineHeightFromFontShorthand(fontDecl = '') {
  const { before, lhRaw } = fontShorthandParts(fontDecl);
  if (!lhRaw) return null;
  const unitless = Number(lhRaw);
  if (Number.isFinite(unitless) && lhRaw !== '' && !/px|em|rem|%/i.test(lhRaw)) return unitless;
  const lhPx = lhRaw.match(/^([\d.]+)px$/i);
  if (lhPx) {
    const fsPx = fontSizePxFromShorthandBefore(before);
    if (fsPx) return Number(lhPx[1]) / fsPx;
    return null;
  }
  return null;
}

function resolveLineHeightRaw(lhRaw, fontSizePx) {
  if (!lhRaw) return null;
  if (TRACKING_TOKEN.test(lhRaw) || /var\(\s*--hermes-display-line-height/i.test(lhRaw)) {
    return LINE_HEIGHT_MIN;
  }
  const unitless = Number(lhRaw);
  if (Number.isFinite(unitless) && !lhRaw.includes('px') && !lhRaw.includes('%')) return unitless;
  const pxMatch = lhRaw.match(/^([\d.]+)px$/i);
  if (pxMatch && fontSizePx) return Number(pxMatch[1]) / fontSizePx;
  return null;
}

export function effectiveFontSizePx(body) {
  let fontSizePx = null;
  for (const decl of declarations(body)) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (prop === 'font-size') {
      const pxFromFs = val.match(/([\d.]+)px/i);
      if (pxFromFs) fontSizePx = Number(pxFromFs[1]);
    } else if (prop === 'font') {
      const px = fontSizePxFromShorthandBefore(fontShorthandParts(val).before);
      if (px != null) fontSizePx = px;
    }
  }
  return fontSizePx;
}

export function effectiveLineHeight(body) {
  let fontSizePx = null;
  let lh = null;
  for (const decl of declarations(body)) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (prop === 'font-size') {
      const pxFromFs = val.match(/([\d.]+)px/i);
      if (pxFromFs) fontSizePx = Number(pxFromFs[1]);
    } else if (prop === 'font') {
      const parts = fontShorthandParts(val);
      const px = fontSizePxFromShorthandBefore(parts.before);
      if (px != null) fontSizePx = px;
      if (parts.lhRaw) {
        lh = resolveLineHeightRaw(parts.lhRaw, fontSizePx) ?? lineHeightFromFontShorthand(val);
      } else {
        lh = null;
      }
    } else if (prop === 'line-height') {
      lh = resolveLineHeightRaw(val, fontSizePx);
    }
  }
  return lh;
}

export function usesDisplayFont(rule) {
  if (SKIP_SELECTOR.test(rule.selector)) return false;
  if (/html\[dir="rtl"\]/i.test(rule.selector)) return false;
  let family = '';
  let font = '';
  for (const decl of declarations(rule.body)) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const val = decl.slice(colon + 1).trim();
    if (prop === 'font-family') family = val;
    else if (prop === 'font') font = val;
  }
  return [family, font].some((value) => value && DISPLAY_MARKERS.test(value));
}

export function auditRule(rule) {
  const errors = [];
  const body = rule.body;
  if (!usesDisplayFont(rule)) return errors;

  const lh = effectiveLineHeight(body);
  const tracking = lastDeclaration(body, 'letter-spacing');
  const trackingEm = emValue(tracking);
  const usesToken = TRACKING_TOKEN.test(tracking);
  const trackingOk = usesToken || (trackingEm != null && trackingEm >= TRACKING_MIN_EM);

  if (lh != null && lh < LINE_HEIGHT_MIN) {
    errors.push(`line-height ${lh} < ${LINE_HEIGHT_MIN}`);
  } else if (lh == null && /^[\d.]+px$/i.test(lastDeclaration(body, 'line-height'))) {
    if (effectiveFontSizePx(body) == null) {
      errors.push('cannot verify line-height: font size is not a known pixel value');
    }
  } else if (lh == null && lastDeclaration(body, 'font') && !fontShorthandParts(lastDeclaration(body, 'font')).lhRaw) {
    errors.push('missing line-height on display-font font shorthand');
  }

  if (!trackingOk) {
    errors.push(`letter-spacing must be >= ${TRACKING_MIN_EM}em or var(--hermes-display-tracking)`);
  }

  const overflowHidden = /overflow\s*:\s*hidden/i.test(body);
  const nowrap = /white-space\s*:\s*nowrap/i.test(body);
  const ellipsis = /text-overflow\s*:\s*ellipsis/i.test(body);
  const padEnd = lastDeclaration(body, 'padding-block-end');
  const padEndEm = emValue(padEnd) ?? (padEnd && Number(padEnd) ? Number(padEnd) / 16 : null);
  if (overflowHidden && (nowrap || ellipsis)) {
    const padOk = padEndEm != null && padEndEm >= 0.1;
    const lhOk = lh != null && lh >= LINE_HEIGHT_MIN;
    if (!padOk && !lhOk) {
      errors.push('overflow hidden + nowrap/ellipsis without padding-block-end >= 0.1em and line-height >= 1.2');
    }
  }

  return errors.map((detail) => ({
    file: rule.file,
    line: rule.line,
    selector: rule.selector,
    detail,
    fix: 'Use var(--hermes-display-tracking) and line-height >= 1.25; avoid clipping descenders on display headlines.',
  }));
}

export function auditCss(css, fileLabel) {
  return parseRules(css, fileLabel).flatMap((rule) => auditRule(rule));
}

export function auditFiles(files = CSS_GLOBS) {
  const all = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const css = fs.readFileSync(abs, 'utf8');
    all.push(...auditCss(css, rel));
  }
  return all;
}

function main() {
  const violations = auditFiles();
  if (violations.length) {
    for (const v of violations) {
      process.stderr.write(`${v.file}:${v.line} ${v.selector}: ${v.detail}. ${v.fix}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`display typography OK (${CSS_GLOBS.length} stylesheets)\n`);
}

const entry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (import.meta.url === entry) {
  main();
}
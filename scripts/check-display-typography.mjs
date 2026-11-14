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

const SKIP_SELECTOR = /@font-face|@keyframes|@media|^\s*@|--hermes-display-tracking|startup-backtype text/i;

export function parseRules(css, fileLabel = '') {
  const rules = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let start = 0;
  let selector = '';
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) {
        selector = stripped.slice(start, i).trim();
        start = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = stripped.slice(start, i).trim();
        const line = (stripped.slice(0, start).match(/\n/g) || []).length + 1;
        rules.push({ selector, body, line, file: fileLabel });
        start = i + 1;
      }
    }
  }
  return rules;
}

export function emValue(raw = '') {
  const match = String(raw).trim().match(/^(-?[\d.]+)em$/i);
  return match ? Number(match[1]) : null;
}

export function lineHeightFromFontShorthand(body) {
  const m = body.match(/font\s*:\s*[^;]*\/\s*([\d.]+)/i);
  return m ? Number(m[1]) : null;
}

function displayFontDecls(body) {
  const decls = [];
  for (const m of body.matchAll(/(?:^|;)\s*font-family\s*:\s*([^;]+)/gi)) decls.push(m[1]);
  for (const m of body.matchAll(/(?:^|;)\s*font\s*:\s*([^;]+)/gi)) decls.push(m[1]);
  return decls;
}

export function usesDisplayFont(rule) {
  if (SKIP_SELECTOR.test(rule.selector)) return false;
  if (/html\[dir="rtl"\]/i.test(rule.selector)) return false;
  return displayFontDecls(rule.body).some((value) => DISPLAY_MARKERS.test(value));
}

export function auditRule(rule) {
  const errors = [];
  const body = rule.body;
  if (!usesDisplayFont(rule)) return errors;

  const fontLh = lineHeightFromFontShorthand(body);
  const lhMatch = body.match(/(?:^|;)\s*line-height\s*:\s*([^;]+)/i);
  const lhRaw = lhMatch?.[1]?.trim() || '';
  let lh = fontLh;
  if (lh == null && lhRaw) {
    const unitless = Number(lhRaw);
    if (Number.isFinite(unitless) && !lhRaw.includes('px')) lh = unitless;
    else if (lhRaw.endsWith('px')) {
      const fsMatch = body.match(/font-size\s*:\s*([^;]+)/i)
        || body.match(/font\s*:\s*[^/]*\/\s*[^;]*\s+[^;]*/i);
      const fsPx = body.match(/([\d.]+)px/);
      if (fsPx) lh = Number(lhRaw) / Number(fsPx[1]);
    }
  }

  const trackingMatch = body.match(/(?:^|;)\s*letter-spacing\s*:\s*([^;]+)/i);
  const tracking = trackingMatch?.[1]?.trim() || '';
  const trackingEm = emValue(tracking);
  const usesToken = TRACKING_TOKEN.test(tracking);
  const trackingOk = usesToken || (trackingEm != null && trackingEm >= TRACKING_MIN_EM);

  if (lh != null && lh < LINE_HEIGHT_MIN) {
    errors.push(`line-height ${lh} < ${LINE_HEIGHT_MIN}`);
  } else if (lh == null && !/line-height\s*:/i.test(body) && /font\s*:/i.test(body) && fontLh == null) {
    errors.push('missing line-height on display-font font shorthand');
  }

  if (!trackingOk) {
    errors.push(`letter-spacing must be >= ${TRACKING_MIN_EM}em or var(--hermes-display-tracking)`);
  }

  const overflowHidden = /overflow\s*:\s*hidden/i.test(body);
  const nowrap = /white-space\s*:\s*nowrap/i.test(body);
  const ellipsis = /text-overflow\s*:\s*ellipsis/i.test(body);
  const padEnd = body.match(/padding-block-end\s*:\s*([^;]+)/i)?.[1];
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
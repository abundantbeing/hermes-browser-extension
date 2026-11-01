import fs from 'node:fs';
import path from 'node:path';

const FONT_URL = /url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/gi;

/** CSS files whose @font-face urls must exist before Chromium or Firefox builds. */
export const FONT_CHECK_CSS_FILES = Object.freeze([
  'extension/sidepanel.css',
  'extension/lib/design-tokens.css',
  'extension/hermes-web-opening.css',
]);

function walkCssFiles(directory, rows = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkCssFiles(absolute, rows);
    else if (entry.isFile() && entry.name.endsWith('.css')) rows.push(absolute);
  }
  return rows;
}

export function resolveFontReference(cssFilePath, urlReference) {
  const url = String(urlReference ?? '').trim();
  if (!url || /^data:/i.test(url) || /^https?:/i.test(url)) return null;
  return path.normalize(path.join(path.dirname(cssFilePath), url));
}

export function referencedFontsInCss(cssSource, cssFilePath) {
  const rows = [];
  for (const match of cssSource.matchAll(FONT_URL)) {
    const resolved = resolveFontReference(cssFilePath, match[1]);
    if (resolved) rows.push({ url: match[1], absolutePath: resolved });
  }
  return rows;
}

export function collectReferencedFontPaths({
  root = process.cwd(),
  cssFiles = FONT_CHECK_CSS_FILES,
} = {}) {
  const references = [];
  for (const relativeCss of cssFiles) {
    const cssPath = path.join(root, relativeCss);
    const source = fs.readFileSync(cssPath, 'utf8');
    for (const row of referencedFontsInCss(source, cssPath)) {
      references.push({ cssFile: relativeCss, ...row });
    }
  }
  return references;
}

export function checkReferencedFonts(options = {}) {
  const root = options.root ?? process.cwd();
  const extensionRoot = path.join(root, 'extension');
  if (options.skip ?? process.env.HERMES_SKIP_FONT_CHECK === '1') {
    return { ok: true, skipped: true, missing: [] };
  }

  const missing = [];
  const seen = new Set();
  for (const row of collectReferencedFontPaths({ root, cssFiles: options.cssFiles })) {
    const key = row.absolutePath;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!row.absolutePath.startsWith(extensionRoot + path.sep)) {
      missing.push({ ...row, reason: 'resolved outside extension/' });
      continue;
    }
    if (!fs.existsSync(row.absolutePath)) {
      missing.push({ ...row, reason: 'file missing on disk' });
    }
  }

  if (missing.length) {
    const detail = missing.map((row) => (
      `${row.cssFile} references ${row.url} (${row.reason}; expected ${path.relative(root, row.absolutePath)})`
    )).join('\n');
    throw new Error(
      `Missing @font-face files referenced in CSS. Commit the font assets or restore the @font-face rule.\n${detail}\n`
      + 'Set HERMES_SKIP_FONT_CHECK=1 only for a deliberate local opt-out.',
    );
  }

  return { ok: true, skipped: false, missing: [] };
}


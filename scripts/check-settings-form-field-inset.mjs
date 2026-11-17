/**
 * Fail when Settings text fields inherit the composer textarea's oversized
 * padding or a non-zero text-indent.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseRules, lastDeclaration } from './check-display-typography.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDEpanel = 'extension/sidepanel.css';
const MAX_INLINE_INSET_PX = 16;
const COMPOSER_TEXTAREA_PADDING_LEFT_PX = 36;
const SETTINGS_TEXTAREA_OVERRIDE = /\.settings-dialog[^,{]*textarea|\.web-settings-dialog[^,{]*textarea/;

function pxValue(raw = '') {
  const match = String(raw).trim().match(/^(-?[\d.]+)px$/i);
  return match ? Number(match[1]) : null;
}

function paddingSides(body) {
  const block = lastDeclaration(body, 'padding');
  if (!block) return null;
  const parts = block.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    const value = pxValue(parts[0]);
    return value == null ? null : { top: value, right: value, bottom: value, left: value };
  }
  if (parts.length === 2) {
    const vertical = pxValue(parts[0]);
    const horizontal = pxValue(parts[1]);
    if (vertical == null || horizontal == null) return null;
    return { top: vertical, right: horizontal, bottom: vertical, left: horizontal };
  }
  if (parts.length === 3) {
    const top = pxValue(parts[0]);
    const horizontal = pxValue(parts[1]);
    const bottom = pxValue(parts[2]);
    if (top == null || horizontal == null || bottom == null) return null;
    return { top, right: horizontal, bottom, left: horizontal };
  }
  if (parts.length === 4) {
    const top = pxValue(parts[0]);
    const right = pxValue(parts[1]);
    const bottom = pxValue(parts[2]);
    const left = pxValue(parts[3]);
    if ([top, right, bottom, left].some((value) => value == null)) return null;
    return { top, right, bottom, left };
  }
  return null;
}

function inlineInsetPx(body) {
  const logical = pxValue(lastDeclaration(body, 'padding-inline-start'));
  if (logical != null) return logical;
  const sides = paddingSides(body);
  if (sides) return sides.left;
  return pxValue(lastDeclaration(body, 'padding-left'));
}

function auditComposerTextareaRule(rules) {
  const bare = rules.find((rule) => rule.selector.trim() === 'textarea');
  if (!bare) {
    return [{ file: SIDEpanel, line: 0, detail: 'missing bare textarea rule' }];
  }
  const inset = inlineInsetPx(bare.body);
  if (inset !== COMPOSER_TEXTAREA_PADDING_LEFT_PX) {
    return [{
      file: SIDEpanel,
      line: bare.line,
      detail: `composer textarea padding-inline-start should stay ${COMPOSER_TEXTAREA_PADDING_LEFT_PX}px (got ${inset ?? 'unset'})`,
    }];
  }
  return [];
}

function auditSettingsTextareaOverride(rules) {
  const overrideRules = rules.filter((rule) => (
    SETTINGS_TEXTAREA_OVERRIDE.test(rule.selector)
    && /\bpadding(?:-inline-start|-left)?\s*:/.test(rule.body)
  ));
  if (!overrideRules.length) {
    return [{ file: SIDEpanel, line: 0, detail: 'missing .settings-dialog textarea padding override' }];
  }
  const violations = [];
  for (const rule of overrideRules) {
    const textIndent = lastDeclaration(rule.body, 'text-indent');
    if (textIndent && textIndent !== '0' && textIndent !== '0px') {
      violations.push({
        file: SIDEpanel,
        line: rule.line,
        selector: rule.selector,
        detail: `text-indent must be 0 on settings textareas (got ${textIndent})`,
      });
    }
    const inset = inlineInsetPx(rule.body);
    if (inset == null) {
      violations.push({
        file: SIDEpanel,
        line: rule.line,
        selector: rule.selector,
        detail: 'settings textarea override must set explicit padding with px values',
      });
      continue;
    }
    if (inset > MAX_INLINE_INSET_PX) {
      violations.push({
        file: SIDEpanel,
        line: rule.line,
        selector: rule.selector,
        detail: `padding-inline-start must be <= ${MAX_INLINE_INSET_PX}px (got ${inset}px)`,
      });
    }
  }
  return violations;
}

function auditSettingsFormFieldRules(rules) {
  const formField = /(?:\.settings-dialog|\.web-settings-dialog|\.settings-pane)\s+(?:input|textarea)(?!\[type=.?checkbox)/;
  const violations = [];
  for (const rule of rules) {
    if (!formField.test(rule.selector)) continue;
    if (!/\bpadding(?:-inline-start|-left)?\s*:/.test(rule.body)) continue;
    if (/composer|#promptInput|model-sources-input/.test(rule.selector)) continue;
    const textIndent = lastDeclaration(rule.body, 'text-indent');
    if (textIndent && textIndent !== '0' && textIndent !== '0px') {
      violations.push({
        file: SIDEpanel,
        line: rule.line,
        selector: rule.selector,
        detail: `text-indent must be 0 on settings fields (got ${textIndent})`,
      });
    }
    const inset = inlineInsetPx(rule.body);
    if (inset != null && inset > MAX_INLINE_INSET_PX && !/marketplace-theme-search/.test(rule.selector)) {
      violations.push({
        file: SIDEpanel,
        line: rule.line,
        selector: rule.selector,
        detail: `padding-inline-start must be <= ${MAX_INLINE_INSET_PX}px without an icon reservation class (got ${inset}px)`,
      });
    }
  }
  return violations;
}

export function auditSettingsFormFieldInsetCss(css, fileLabel = SIDEpanel) {
  const rules = parseRules(css, fileLabel);
  return [
    ...auditComposerTextareaRule(rules),
    ...auditSettingsTextareaOverride(rules),
    ...auditSettingsFormFieldRules(rules),
  ];
}

export function auditSettingsFormFieldInsetFile(relPath = SIDEpanel) {
  const abs = path.join(root, relPath);
  return auditSettingsFormFieldInsetCss(fs.readFileSync(abs, 'utf8'), relPath);
}

function main() {
  const violations = auditSettingsFormFieldInsetFile();
  if (violations.length) {
    for (const violation of violations) {
      const label = violation.selector ? `${violation.selector}: ` : '';
      process.stderr.write(`${violation.file}:${violation.line} ${label}${violation.detail}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('settings form-field inset OK\n');
}

const entry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (import.meta.url === entry) {
  main();
}
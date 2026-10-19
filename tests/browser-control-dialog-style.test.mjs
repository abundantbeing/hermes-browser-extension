import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const css = (await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Every style rule as { selector, body }. Rules inside an at-rule (@media) are matched on
// their own, so the checks below see them as ordinary rules.
function styleRules(source) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    body,
  }));
}

const rules = styleRules(css);
// The Hermes Control window and the parts its markup gives it.
const dialogRule = /\.browser-control-(dialog|dismiss|tooltip|tab-option|tabs|strip|action|field|view|config|titlebar|light)\b/;
const dialogRules = rules.filter((rule) => dialogRule.test(rule.selector));

test('Hermes Control window corners are square: no border-radius other than the theme radius or 0', () => {
  const offenders = [];
  for (const rule of dialogRules) {
    for (const match of rule.body.matchAll(/(?:^|[;{\s])(border[a-z-]*radius)\s*:\s*([^;}]+)/g)) {
      const value = match[2].trim();
      // The status light's dot is round, like the Settings status dot; every box stays square.
      if (/light-dot/.test(rule.selector) && value === '50%') continue;
      if (!/^(var\(--radius\)|0(px)?)$/.test(value)) offenders.push(`${rule.selector} { ${match[1]}: ${value} }`);
    }
  }
  assert.deepEqual(offenders, []);
  const box = rules.find((rule) => rule.selector === '.browser-control-dialog');
  assert.match(box?.body || '', /border-radius:\s*var\(--radius\)/);
});

test('Hermes Control window keeps a frosted surface, with a reduced-transparency fallback that turns it off', () => {
  const box = rules.find((rule) => rule.selector === '.browser-control-dialog');
  assert.ok(box, 'the dialog box rule exists');
  assert.match(box.body, /backdrop-filter:\s*blur\(14px\) saturate\(1\.2\)/);
  assert.match(box.body, /background:\s*color-mix\(in srgb, var\(--hermes-paper\) 82%, transparent\)/);
  const fallback = css.match(/@media \(prefers-reduced-transparency:\s*reduce\),\s*\(forced-colors:\s*active\)\s*\{\s*\.browser-control-dialog\s*\{([^}]*)\}\s*\}/);
  assert.ok(fallback, 'the reduced-transparency and forced-colours fallback exists');
  assert.match(fallback[1], /background:\s*var\(--hermes-paper\)/);
  assert.match(fallback[1], /backdrop-filter:\s*none/);
  // The dimmed backdrop keeps its blur; it has no radius or glow of its own.
  const backdrop = rules.find((rule) => rule.selector === '.browser-control-dialog::backdrop');
  assert.ok(backdrop, 'the backdrop rule exists');
  assert.match(backdrop.body, /backdrop-filter:\s*blur\(/);
  assert.doesNotMatch(backdrop.body, /border-radius|box-shadow/);
});

test('Hermes Control title is the Settings heading: display face, accent colour, one line, no 28px or 34px size', () => {
  const titleRules = rules.filter((rule) => /browser-control-dialog-title\b/.test(rule.selector));
  assert.ok(titleRules.length > 0, 'the title has a rule');
  for (const rule of titleRules) {
    assert.doesNotMatch(rule.body, /\b(28|34)px\b/, `${rule.selector} still sets a 28px or 34px title`);
  }
  assert.doesNotMatch(css, /font-profile="signature"\]\s+\.browser-control-dialog-title\s*\{[^}]*font-size/);
  const titleBody = titleRules.map((rule) => rule.body).join('\n');
  // The display scale is the one the app gives display headlines under the signature profile (1.3), unset elsewhere.
  assert.match(titleBody, /font:\s*500 calc\(16px \* var\(--hermes-text-zoom,\s*1\) \* var\(--hermes-display-scale,\s*1\)\)\/1\.15 var\(--hermes-font-display\)/);
  assert.match(titleBody, /color:\s*var\(--control-accent\)/);
  // Headings wrap only between words: no forced break inside a word.
  assert.doesNotMatch(titleBody, /overflow-wrap:\s*anywhere|word-break:\s*break-all/);
  const titlebar = rules.find((rule) => rule.selector === '.browser-control-dialog .browser-control-titlebar');
  assert.match(titlebar?.body || '', /flex-wrap:\s*wrap/, 'the title row wraps, so the light can drop below a long title');
});

test('the scope sits under the title row and above the actions, with no pinned row that would leave an empty track', () => {
  const scope = rules.find((rule) => rule.selector === '.browser-control-dialog-config');
  const actions = rules.find((rule) => rule.selector === '.browser-control-dialog .browser-control-strip-actions');
  assert.match(scope?.body || '', /order:\s*2/, 'the scope takes the second slot');
  assert.match(actions?.body || '', /order:\s*3/, 'the actions take the third slot');
  for (const rule of rules.filter((rule) => /\.browser-control-(strip|dialog-config|config)\b/.test(rule.selector))) {
    assert.doesNotMatch(rule.body, /grid-row/, `${rule.selector} pins a row, which leaves an empty track when the detail is hidden`);
  }
});

test('Hermes Control state shows as an ON/OFF light in the title row; the chip, flare and energy line are gone', () => {
  assert.match(css, /\.browser-control-dialog \.browser-control-flare,\s*\.browser-control-dialog \.browser-control-energy\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /border-left:\s*3px solid var\(--control-energy\)/);
  // The big chip (a bordered, uppercase label in the strip) and its live dot are retired.
  assert.doesNotMatch(css, /\.browser-control-dialog \.browser-control-strip-copy strong \{[^}]*border:\s*1px solid/);
  assert.doesNotMatch(css, /live-indicator/);
  const light = rules.find((rule) => rule.selector === '.browser-control-dialog .browser-control-light');
  assert.ok(light, 'the status light rule exists');
  assert.match(light.body, /text-transform:\s*uppercase/);
  assert.match(light.body, /font:\s*700 calc\(11px \* var\(--hermes-text-zoom, 1\)\)\/1 var\(--hermes-font-ui\)/);
  const dot = rules.find((rule) => rule.selector === '.browser-control-dialog .browser-control-light-dot');
  assert.ok(dot, 'the status light dot rule exists');
  assert.match(dot.body, /border-radius:\s*50%/);
  // A surface-coloured ring, then a thin ring in the dot colour, so the dot separates from any background.
  assert.match(dot.body, /box-shadow:\s*0 0 0 2px var\(--hermes-paper\),\s*0 0 0 3px var\(--light-color\)/);
  assert.match(css, /\.browser-control-dialog \.browser-control-light\[data-state="on"\] \.browser-control-light-dot \{ animation: control-heartbeat/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[^@]*?light\[data-state="on"\] \.browser-control-light-dot \{ animation: none; \}/);
});

test('the status light colours are theme tokens defined per mode, and they hold 3:1 on every built-in window surface', async () => {
  const themes = await readFile(new URL('../extension/sidepanel-themes.css', import.meta.url), 'utf8');
  const token = (selector, name) => {
    const block = themes.match(new RegExp(`${selector.replace(/[[\]="]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] || '';
    return block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  };
  const dark = { on: token(':root', '--control-on'), off: token(':root', '--control-off') };
  const light = { on: token('html[data-hermes-mode="light"]', '--control-on'), off: token('html[data-hermes-mode="light"]', '--control-off') };
  for (const colour of [dark.on, dark.off, light.on, light.off]) assert.match(colour || '', /^#[0-9a-f]{6}$/i, 'each mode defines both colours');
  // The --hermes-paper of each built-in theme and mode (the window sits on this paper), plus the default.
  const darkPapers = ['#0a3572', '#121029', '#2a0b02', '#171717', '#001b08', '#0f1a22', '#10221f', '#24111d', '#28231b', '#2d353b', '#232335', '#101b30'];
  const lightPapers = ['#ffffff', '#fffaf6', '#fbfffc', '#fbf8ef', '#fff7fb', '#fffbf3', '#fdf6e3', '#f0f0ef', '#fbfcff'];
  for (const paper of darkPapers) {
    assert.ok(contrast(dark.on, paper) >= 3, `dark ON ${dark.on} on ${paper}`);
    assert.ok(contrast(dark.off, paper) >= 3, `dark OFF ${dark.off} on ${paper}`);
  }
  for (const paper of lightPapers) {
    assert.ok(contrast(light.on, paper) >= 3, `light ON ${light.on} on ${paper}`);
    assert.ok(contrast(light.off, paper) >= 3, `light OFF ${light.off} on ${paper}`);
  }
  // The ON dot pulses down to its floor opacity; the dimmest point must still hold 3:1 on each light paper.
  const floor = Number(css.match(/@keyframes control-heartbeat\s*\{\s*0%,\s*100%\s*\{\s*opacity:\s*([\d.]+)/)?.[1]);
  assert.ok(floor >= 0.9, `the pulse floor is ${floor}`);
  const atFloor = (hex, paper) => `#${[1, 3, 5].map((i) => Math.round(
    parseInt(hex.slice(i, i + 2), 16) * floor + parseInt(paper.slice(i, i + 2), 16) * (1 - floor),
  ).toString(16).padStart(2, '0')).join('')}`;
  for (const paper of lightPapers) {
    assert.ok(contrast(atFloor(light.on, paper), paper) >= 3, `light ON at the pulse floor on ${paper}`);
  }
});

// WCAG 2.x contrast ratio between two #rrggbb colours.
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((index) => {
      const c = parseInt(hex.slice(index, index + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('Hermes Control window colours come from theme tokens only', () => {
  for (const rule of dialogRules) {
    assert.doesNotMatch(rule.body, /#[0-9a-fA-F]{3,8}\b/, `${rule.selector} has a hex colour`);
    assert.doesNotMatch(rule.body, /\b(rgb|hsl)a?\(\s*\d/, `${rule.selector} has a literal colour`);
  }
});

test('the Hermes Control window uses the Settings card fonts in every profile', () => {
  // Settings sizes its label eyebrow (10px, weight 700) and the scope picker reads its size from the label.
  const settingsLabel = rules.find((rule) => /(^|,\s*)\.settings-dialog label(,|$)/.test(rule.selector));
  assert.ok(settingsLabel, 'the Settings label rule exists');
  assert.match(settingsLabel.body, /font-size:\s*calc\(10px \* var\(--hermes-text-zoom,\s*1\)\)/);
  assert.match(settingsLabel.body, /font-weight:\s*700/);
  // Only the scope field's label takes the eyebrow size. A window-wide label rule would also shrink the per-tab options (12px).
  const windowLabel = rules.find((rule) => rule.selector === '.browser-control-dialog label.browser-control-field');
  assert.match(windowLabel?.body || '', /font-size:\s*calc\(10px \* var\(--hermes-text-zoom,\s*1\)\)/);
  assert.match(windowLabel?.body || '', /font-weight:\s*700/);
  assert.equal(rules.some((rule) => rule.selector === '.browser-control-dialog label'), false, 'no window-wide label rule');
  const tabOption = rules.find((rule) => rule.selector === '.browser-control-tab-option');
  assert.match(tabOption?.body || '', /font:\s*400 calc\(12px \* var\(--hermes-text-zoom,\s*1\)\)\/1\.4 var\(--hermes-font-ui\)/);
  // The signature profile keeps its own 13px label size.
  const signatureLabel = rules.find((rule) => rule.selector === 'html[data-hermes-font-profile="signature"] .browser-control-dialog label');
  assert.match(signatureLabel?.body || '', /font-size:\s*calc\(13px \* var\(--hermes-text-zoom,\s*1\)\)/);
  // Action buttons take the Settings spacing in every profile, not 0.05em.
  const action = rules.find((rule) => rule.selector === '.browser-control-action');
  assert.match(action.body, /letter-spacing:\s*0\.03em/);
  const everyProfile = rules.find((rule) => rule.selector === 'html[data-hermes-font-profile] .browser-control-dialog .browser-control-action');
  assert.match(everyProfile?.body || '', /letter-spacing:\s*0\.03em/);
  assert.match(everyProfile?.body || '', /text-transform:\s*uppercase/);
  assert.doesNotMatch(css, /\.browser-control-dialog \.browser-control-action[^{]*\{[^}]*letter-spacing:\s*0\.05em/);
  // The scope helper text is the Settings helper text: mono, weight 400, the Settings note size and line height.
  const hint = rules.find((rule) => rule.selector === '.browser-control-dialog .browser-control-field small');
  assert.match(hint?.body || '', /font:\s*400 calc\(11px \* var\(--hermes-text-zoom,\s*1\)\)\/1\.55 var\(--hermes-font-mono\)/);
  const settingsNote = rules.find((rule) => rule.selector === '.browser-control-note');
  assert.match(settingsNote?.body || '', /font:\s*calc\(11px \* var\(--hermes-text-zoom,\s*1\)\)\/1\.55 var\(--hermes-font-mono\)/);
  // The signature-only action rules repeated values the shared rule now sets; they are gone.
  assert.doesNotMatch(css, /html\[data-hermes-font-profile="signature"\] \.browser-control-dialog \.browser-control-action \{/);
  // The Settings kicker is the reference size. The window title matches it, and under the signature profile
  // it takes the display scale that the app gives display headlines there, since that face is narrow.
  const kicker = rules.find((rule) => rule.selector === '.browser-control-kicker');
  const title = rules.find((rule) => rule.selector === '.browser-control-dialog .browser-control-dialog-title');
  assert.match(kicker?.body || '', /font:\s*500 calc\(16px \* var\(--hermes-text-zoom,\s*1\)\)\/1\.15 var\(--hermes-font-display\)/);
  assert.match(title?.body || '', /font:\s*500 calc\(16px \* var\(--hermes-text-zoom,\s*1\) \* var\(--hermes-display-scale,\s*1\)\)\/1\.15 var\(--hermes-font-display\)/);
});

test('the composer launcher stays square', () => {
  const launcher = rules.find((rule) => rule.selector === '.composer-actions #browserControlMenuButton');
  assert.ok(launcher, 'the launcher rule exists');
  assert.match(launcher.body, /border-radius:\s*var\(--radius\)/);
});

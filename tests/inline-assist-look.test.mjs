import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import {
  INLINE_ASSIST_FONT_FILES,
  INLINE_ASSIST_FONT_PREFIX,
  INLINE_ASSIST_ICONS,
  circleToneForBackground,
  inlineAssistFontStacks,
  namespaceFontStack,
  inlineAssistIconAsset,
  normalizeInlineAssistIcon,
  normalizeInlineAssistOpenMode,
  parseCssColor,
} from '../extension/lib/inline-assist-look.mjs';

test('the trigger icon is one of wing, staff or girl, and wing by default', () => {
  assert.deepEqual([...INLINE_ASSIST_ICONS], ['wing', 'staff', 'girl']);
  assert.equal(normalizeInlineAssistIcon('staff'), 'staff');
  assert.equal(normalizeInlineAssistIcon('girl'), 'girl');
  assert.equal(normalizeInlineAssistIcon('nope'), 'wing');
  assert.equal(normalizeInlineAssistIcon(undefined), 'wing');
});

test('clicking the trigger opens the full panel unless the quick menu was chosen', () => {
  assert.equal(normalizeInlineAssistOpenMode('quick'), 'quick');
  assert.equal(normalizeInlineAssistOpenMode('panel'), 'panel');
  assert.equal(normalizeInlineAssistOpenMode('menu'), 'panel');
  assert.equal(normalizeInlineAssistOpenMode(null), 'panel');
});

test('computed background colours parse, and anything else is null', () => {
  assert.deepEqual(parseCssColor('rgb(0, 0, 0)'), { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(parseCssColor('rgba(0, 0, 0, 0)').a, 0);
  assert.deepEqual(parseCssColor('rgba(48, 48, 48, 0.5)'), { r: 48, g: 48, b: 48, a: 0.5 });
  assert.deepEqual(parseCssColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssColor('#303030'), { r: 48, g: 48, b: 48, a: 1 });
  assert.deepEqual(parseCssColor('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseCssColor('garbage'), null);
  assert.equal(parseCssColor(''), null);
});

test('the circle takes the opposite tone of the page behind it', () => {
  assert.equal(circleToneForBackground({ r: 0, g: 0, b: 0 }), 'light', 'X');
  assert.equal(circleToneForBackground({ r: 255, g: 255, b: 255 }), 'dark', 'Gmail');
  assert.equal(circleToneForBackground({ r: 48, g: 48, b: 48 }), 'light', 'ChatGPT composer');
  assert.equal(circleToneForBackground({ r: 244, g: 242, b: 238 }), 'dark', 'LinkedIn');
});

test('no opaque ancestor → dark circle, as on a white page', () => {
  assert.equal(circleToneForBackground(null), 'dark');
});

test('each icon and tone names a packaged image', () => {
  assert.equal(inlineAssistIconAsset('wing', 'light'), 'assets/img/assist-wing.png');
  assert.equal(inlineAssistIconAsset('wing', 'dark'), 'assets/img/assist-wing.png');
  assert.equal(inlineAssistIconAsset('staff', 'light'), 'assets/img/assist-staff.svg');
  assert.equal(inlineAssistIconAsset('girl', 'dark'), 'assets/img/assist-girl-outline.png');
  assert.equal(inlineAssistIconAsset('girl', 'light'), 'assets/img/assist-girl-solid.png');
  assert.equal(inlineAssistIconAsset('unknown', 'light'), 'assets/img/assist-wing.png');
});

function fontFaces(file, base) {
  const css = readFileSync(new URL(file, new URL('../extension/', import.meta.url)), 'utf8');
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, block]) => ({
    family: /font-family:\s*['"]?([^'";]+)['"]?/.exec(block)?.[1],
    file: new URL(/url\(['"]?([^'")]+)['"]?\)/.exec(block)?.[1], `https://x/${base}`).pathname.slice(1),
    weight: /font-weight:\s*([^;]+);/.exec(block)?.[1]?.trim() || '400',
    style: /font-style:\s*([^;]+);/.exec(block)?.[1]?.trim() || 'normal',
  }));
}

test('the Assist font table mirrors the faces the extension already declares', () => {
  const declared = [...fontFaces('sidepanel.css', ''), ...fontFaces('lib/fonts.css', 'lib/')];
  for (const [family, faces] of Object.entries(INLINE_ASSIST_FONT_FILES)) {
    for (const face of faces) {
      assert.ok(declared.some((entry) => entry.family === family && entry.file === face.file && entry.weight === face.weight && entry.style === face.style), `${family} ${face.file}`);
    }
  }
  for (const family of ['Rules Variable', 'Rules Gothic Compressed', 'Space Grotesk', 'HermesDisplay', 'HermesMono', 'Collapse', 'Montserrat', 'Cinzel']) {
    assert.ok(INLINE_ASSIST_FONT_FILES[family]?.length, family);
  }
});

test('bundled families in a stack are renamed so they never clash with the page', () => {
  assert.equal(INLINE_ASSIST_FONT_PREFIX, 'HermesAssist ');
  assert.deepEqual(namespaceFontStack('"Rules Variable", "Segoe UI", sans-serif'), {
    stack: '"HermesAssist Rules Variable", "Segoe UI", sans-serif',
    families: ['Rules Variable'],
  });
  assert.deepEqual(namespaceFontStack('var(--hermes-font-mono)'), { stack: 'var(--hermes-font-mono)', families: [] });
  assert.deepEqual(namespaceFontStack('Georgia, "Times New Roman", serif'), { stack: 'Georgia, "Times New Roman", serif', families: [] });
});

test('the signature profile pairs Rules Variable text with Rules Gothic Compressed headings', () => {
  const stacks = inlineAssistFontStacks('signature', '"Rules Gothic Compressed", "HermesDisplay", "Rules Variable", "Space Grotesk", sans-serif');
  assert.equal(stacks.ui, '"HermesAssist Rules Variable", "HermesAssist Space Grotesk", "Segoe UI", system-ui, sans-serif');
  assert.equal(stacks.display, '"HermesAssist Rules Gothic Compressed", "HermesAssist HermesDisplay", "HermesAssist Rules Variable", "HermesAssist Space Grotesk", sans-serif');
  assert.equal(stacks.mono, '"HermesAssist HermesMono", ui-monospace, Consolas, monospace');
  assert.deepEqual([...stacks.families].sort(), ['HermesDisplay', 'HermesMono', 'Rules Gothic Compressed', 'Rules Variable', 'Space Grotesk']);
});

test('any other profile uses its own stack for text and headings alike', () => {
  const stacks = inlineAssistFontStacks('montserrat', '"Montserrat", "Segoe UI", sans-serif');
  assert.equal(stacks.ui, '"HermesAssist Montserrat", "Segoe UI", sans-serif');
  assert.equal(stacks.display, stacks.ui);
  assert.deepEqual([...stacks.families].sort(), ['HermesMono', 'Montserrat']);
  assert.equal(inlineAssistFontStacks('mono', 'var(--hermes-font-mono)').ui, 'var(--hermes-font-mono)');
});

test('modern colour syntaxes Chrome reports as written still decide the tone', () => {
  assert.equal(circleToneForBackground(parseCssColor('oklch(0.145 0 0)')), 'light', 'shadcn dark background');
  assert.equal(circleToneForBackground(parseCssColor('oklch(1 0 0)')), 'dark');
  assert.equal(circleToneForBackground(parseCssColor('oklch(0.21 0.034 264.665)')), 'light', 'Tailwind gray-900');
  assert.equal(circleToneForBackground(parseCssColor('oklab(0.98 0 0)')), 'dark');
  assert.equal(parseCssColor('oklab(0.2 0.01 0.01 / 0.5)').a, 0.5);
  assert.equal(circleToneForBackground(parseCssColor('lab(10 0 0)')), 'light');
  assert.equal(circleToneForBackground(parseCssColor('lch(96 2 90)')), 'dark');
  const mixed = parseCssColor('color(srgb 0.1 0.1 0.1)');
  assert.deepEqual([mixed.r, mixed.g, mixed.b, mixed.a], [26, 26, 26, 1]);
  assert.equal(parseCssColor('color(display-p3 1 1 1 / 0)').a, 0);
});

test('color() converts each colour space before the tone is chosen', () => {
  const near = (value, expected, label) => {
    const color = parseCssColor(value);
    for (const key of ['r', 'g', 'b']) assert.ok(Math.abs(color[key] - expected[key]) <= 2, `${label}: ${key} ${color[key]} vs ${expected[key]}`);
  };
  const gray = (level) => ({ r: level, g: level, b: level });
  near('color(xyz-d65 0.570282 0.6 0.653298)', gray(203), 'xyz-d65 light gray');
  near('color(xyz 0.570282 0.6 0.653298)', gray(203), 'xyz is xyz-d65');
  near('color(xyz-d50 0.578526 0.6 0.495060)', gray(203), 'xyz-d50 light gray');
  near('color(display-p3 1 1 1)', gray(255), 'p3 white');
  near('color(display-p3 1 0 0)', { r: 255, g: 0, b: 0 }, 'p3 red clips to sRGB red');
  near('color(a98-rgb 0.5 0.5 0.5)', gray(128), 'a98 mid gray');
  near('color(prophoto-rgb 0.5 0.5 0.5)', gray(146), 'prophoto mid gray');
  near('color(rec2020 0.5 0.5 0.5)', gray(140), 'rec2020 mid gray');
  near('color(srgb-linear 0.2140 0.2140 0.2140)', gray(128), 'linear sRGB');
  assert.equal(circleToneForBackground(parseCssColor('color(xyz-d65 0.570282 0.6 0.653298)')), 'dark');
  assert.equal(circleToneForBackground(parseCssColor('color(xyz-d65 0.03 0.03 0.03)')), 'light');
});

test('given a namer, bundled families get names that do not carry the family', () => {
  const names = new Map([['Rules Variable', 'HermesAssist-1a2b3c4d 7f01'], ['Space Grotesk', 'HermesAssist-1a2b3c4d 09ee']]);
  assert.deepEqual(namespaceFontStack('"Rules Variable", "Space Grotesk", "Segoe UI", sans-serif', (family) => names.get(family)), {
    stack: '"HermesAssist-1a2b3c4d 7f01", "HermesAssist-1a2b3c4d 09ee", "Segoe UI", sans-serif',
    families: ['Rules Variable', 'Space Grotesk'],
  });
  const stacks = inlineAssistFontStacks('signature', '', (family) => `X ${family.length}`);
  assert.doesNotMatch(`${stacks.ui} ${stacks.display} ${stacks.mono}`, /Rules|Grotesk|HermesDisplay|HermesMono/);
});

test('a transparent page under a dark colour-scheme gets the light circle', () => {
  assert.equal(circleToneForBackground(null, { colorScheme: 'dark' }), 'light');
  assert.equal(circleToneForBackground(null, { colorScheme: 'light dark' }), 'dark');
  assert.equal(circleToneForBackground(null, { colorScheme: 'normal' }), 'dark');
});

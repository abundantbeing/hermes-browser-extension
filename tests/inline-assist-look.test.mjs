import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INLINE_ASSIST_ICONS,
  circleToneForBackground,
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

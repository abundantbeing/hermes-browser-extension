// F2 (v0.3.4 signature font rider): the availability probe is pure and async
// so it can be unit-tested without a DOM. sidepanel.js calls it with
// document.fonts to decide whether the honest fallback note shows.
//
// document.fonts.check() is deliberately NOT used: it returns true for a
// family that has no registered @font-face, so it can never tell us whether the
// licensed Rules face actually resolved. These tests pin the FontFaceSet
// iteration/status/load contract that replaces it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNATURE_DISPLAY_FACE,
  SIGNATURE_UI_FACE,
  probeSignatureFonts,
} from '../extension/lib/font-availability.mjs';

// Minimal FontFaceSet stand-in: iterable, with a load() that transitions any
// unloaded face to the status its source dictates ('loaded' or 'error').
function faceSet(faces, { resolve = 'loaded' } = {}) {
  const set = new Set(faces);
  set.loadCalls = [];
  set.load = async (font) => {
    set.loadCalls.push(font);
    const target = String(font).toLowerCase();
    for (const face of faces) {
      if (face.status !== 'unloaded') continue;
      const family = String(face.family).replace(/["']/g, '').toLowerCase();
      if (target.includes(family)) face.status = face.__resolvesTo || resolve;
    }
    return faces;
  };
  return set;
}

function face(family, status) {
  return { family, status };
}

test('reports licensed when both registered Rules faces are loaded', async () => {
  const fontSet = faceSet([
    face(`"${SIGNATURE_UI_FACE}"`, 'loaded'),
    face(SIGNATURE_DISPLAY_FACE, 'loaded'),
  ]);
  const result = await probeSignatureFonts(fontSet);
  assert.equal(result.status, 'licensed');
  assert.equal(result.usesFallback, false);
  assert.equal(result.ui, 'available');
  assert.equal(result.display, 'available');
});

test('reports fallback when a registered Rules face failed to load', async () => {
  const fontSet = faceSet([
    face(SIGNATURE_UI_FACE, 'error'),
    face(SIGNATURE_DISPLAY_FACE, 'loaded'),
  ]);
  const result = await probeSignatureFonts(fontSet);
  assert.equal(result.status, 'fallback');
  assert.equal(result.usesFallback, true);
  assert.equal(result.ui, 'missing');
  assert.equal(result.display, 'available');
});

test('reports fallback when no face is registered for the family', async () => {
  const fontSet = faceSet([]);
  const result = await probeSignatureFonts(fontSet);
  assert.equal(result.status, 'fallback');
  assert.equal(result.ui, 'missing');
  assert.equal(result.display, 'missing');
});

test('never trusts fontSet.check, which is true for missing families', async () => {
  // The old probe used document.fonts.check and a nonexistent family returned
  // true. The probe must ignore that signal entirely.
  const fontSet = faceSet([]);
  fontSet.check = () => true;
  const result = await probeSignatureFonts(fontSet);
  assert.equal(result.status, 'fallback');
});

test('forces an unloaded face to settle via load() and reports it available', async () => {
  const fontSet = faceSet([
    face(SIGNATURE_UI_FACE, 'unloaded'),
    face(SIGNATURE_DISPLAY_FACE, 'unloaded'),
  ]);
  const result = await probeSignatureFonts(fontSet);
  assert.equal(result.status, 'licensed');
  assert.equal(fontSet.loadCalls.length, 2, 'load() must be called for both faces');
});

test('reports fallback when load() settles a registered face as errored', async () => {
  const fontSet = faceSet([
    face(SIGNATURE_UI_FACE, 'unloaded'),
    face(SIGNATURE_DISPLAY_FACE, 'unloaded'),
  ], { resolve: 'error' });
  const result = await probeSignatureFonts(fontSet);
  assert.equal(result.status, 'fallback');
  assert.equal(result.ui, 'missing');
});

test('reports unknown (never false certainty) when fontSet is null', async () => {
  const result = await probeSignatureFonts(null);
  assert.equal(result.status, 'unknown');
  assert.equal(result.usesFallback, false);
  assert.equal(result.ui, 'unknown');
  assert.equal(result.display, 'unknown');
});

test('reports unknown when the font set is not iterable', async () => {
  const result = await probeSignatureFonts({ check: () => true });
  assert.equal(result.status, 'unknown');
});

test('reports unknown when iteration throws', async () => {
  const fontSet = {
    [Symbol.iterator]() { throw new Error('no font API'); },
  };
  const result = await probeSignatureFonts(fontSet);
  assert.equal(result.status, 'unknown');
});

test('stays missing when load() rejects and no face is registered', async () => {
  const fontSet = faceSet([]);
  fontSet.load = async () => { throw new Error('network'); };
  const result = await probeSignatureFonts(fontSet);
  assert.equal(result.status, 'fallback');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const [surface, noteKey, counter] of [
  ['sidepanel', 'signatureFontFallbackNote', 'signatureNoteProbeId'],
]) {
  test(`${surface} non-signature selection invalidates a pending font probe`, async () => {
    const source = readFileSync(new URL(`../extension/${surface}.js`, import.meta.url), 'utf8');
    const fn = source.match(/async function refreshSignatureFontFallbackNote\(fontProfile\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(fn);
    let resolve;
    const note = { hidden: true };
    const context = vm.createContext({
      els: { [noteKey]: note }, document: { fonts: {} },
      probeSignatureFonts: () => new Promise((done) => { resolve = done; }),
    });
    vm.runInContext(`let ${counter} = 0; ${fn}`, context);
    const pending = vm.runInContext("refreshSignatureFontFallbackNote('signature')", context);
    await vm.runInContext("refreshSignatureFontFallbackNote('system')", context);
    resolve({ status: 'fallback' });
    await pending;
    assert.equal(note.hidden, true, 'an old signature probe must not reveal a note after switching fonts');
  });
}

import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';

import {
  VSIX_LIMITS,
  crc32,
  extractVsixThemes,
} from '../extension/lib/vsix-theme-extractor.mjs';

const encoder = new TextEncoder();
const u16 = (value) => [value & 255, (value >>> 8) & 255];
const u32 = (value) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];

function zip(entries, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const plain = typeof entry.data === 'string' ? encoder.encode(entry.data) : new Uint8Array(entry.data);
    const compressed = entry.method === 8 ? new Uint8Array(deflateRawSync(plain)) : plain;
    const flags = entry.flags ?? 0x0800;
    const method = entry.method ?? 0;
    const checksum = entry.crc ?? crc32(plain);
    const declaredCompressed = entry.compressedSize ?? compressed.length;
    const declaredPlain = entry.uncompressedSize ?? plain.length;
    const localName = encoder.encode(entry.localName ?? entry.name);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0),
      ...u32(checksum), ...u32(declaredCompressed), ...u32(declaredPlain), ...u16(localName.length), ...u16(0),
      ...localName, ...compressed,
    ]);
    locals.push(local);
    const central = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0),
      ...u32(checksum), ...u32(declaredCompressed), ...u32(declaredPlain), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
    ]);
    centrals.push(central);
    offset += local.length;
  }
  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const count = options.entryCount ?? entries.length;
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(options.disk ?? 0), ...u16(options.centralDisk ?? 0),
    ...u16(count), ...u16(count), ...u32(options.centralSize ?? centralSize),
    ...u32(options.centralOffset ?? centralOffset), ...u16(0),
  ]);
  const total = locals.reduce((sum, item) => sum + item.length, 0) + centralSize + eocd.length;
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) { result.set(part, cursor); cursor += part.length; }
  return result;
}

function manifest(themes = [{ label: 'Demo', uiTheme: 'vs-dark', path: './themes/demo.json' }]) {
  return JSON.stringify({ name: 'demo', version: '1.2.3', contributes: { themes } });
}

function validEntries(method = 0) {
  return [
    { name: 'extension/package.json', data: manifest(), method },
    { name: 'extension/themes/demo.json', data: JSON.stringify({ name: 'Demo', type: 'dark', colors: { 'editor.background': '#101010' } }), method },
  ];
}

async function rejectsCode(bytes, code) {
  await assert.rejects(() => extractVsixThemes(bytes), (error) => error?.code === code, `expected ${code}`);
}

test('exports the locked archive limits', () => {
  assert.equal(VSIX_LIMITS.archiveBytes, 20 * 1024 * 1024);
  assert.equal(VSIX_LIMITS.entries, 4096);
  assert.equal(VSIX_LIMITS.packageBytes, 256 * 1024);
  assert.equal(VSIX_LIMITS.themeBytes, 512 * 1024);
  assert.equal(VSIX_LIMITS.totalThemeBytes, 4 * 1024 * 1024);
  assert.equal(VSIX_LIMITS.ratio, 100);
});

test('extracts stored package and contributed theme entries', async () => {
  const result = await extractVsixThemes(zip(validEntries()));
  assert.equal(result.packageVersion, '1.2.3');
  assert.equal(result.themes.length, 1);
  assert.equal(result.themes[0].label, 'Demo');
  assert.match(result.themes[0].contents, /editor\.background/);
});

test('extracts deflated package and theme entries', async () => {
  const result = await extractVsixThemes(zip(validEntries(8)));
  assert.equal(result.themes.length, 1);
});

test('returns all contributed light and dark variants in manifest order', async () => {
  const entries = [
    { name: 'extension/package.json', data: manifest([
      { label: 'Light', uiTheme: 'vs', path: './themes/light.json' },
      { label: 'Dark', uiTheme: 'vs-dark', path: './themes/dark.json' },
    ]) },
    { name: 'extension/themes/light.json', data: '{"type":"light","colors":{}}' },
    { name: 'extension/themes/dark.json', data: '{"type":"dark","colors":{}}' },
  ];
  assert.deepEqual((await extractVsixThemes(zip(entries))).themes.map((item) => item.label), ['Light', 'Dark']);
});

test('rejects missing manifest, no color themes, and missing referenced variants', async () => {
  await rejectsCode(zip([{ name: 'extension/x.txt', data: 'x' }]), 'manifest-missing');
  await rejectsCode(zip([{ name: 'extension/package.json', data: manifest([]) }]), 'no-color-themes');
  await rejectsCode(zip([{ name: 'extension/package.json', data: manifest() }]), 'theme-file-missing');
});

test('rejects traversal, backslash, absolute, drive, null, and empty path segments', async () => {
  for (const name of ['../x', 'extension\\x', '/x', 'C:/x', 'extension/../x', 'extension//x', 'extension/\0x']) {
    await rejectsCode(zip([{ name, data: 'x' }]), 'invalid-entry-path');
  }
});

test('rejects encrypted and unsupported required entries', async () => {
  await rejectsCode(zip(validEntries().map((entry, index) => index ? entry : { ...entry, flags: 0x0801 })), 'encrypted-entry');
  await rejectsCode(zip(validEntries().map((entry, index) => index ? entry : { ...entry, method: 12 })), 'unsupported-compression');
});

test('rejects missing, duplicate, truncated, multi-disk, and ZIP64 end records', async () => {
  await rejectsCode(new Uint8Array([1, 2, 3]), 'end-record-missing');
  const base = zip(validEntries());
  const duplicate = new Uint8Array(base.length + 22); duplicate.set(base); duplicate.set(base.slice(-22), base.length);
  await rejectsCode(duplicate, 'end-record-duplicate');
  await rejectsCode(base.slice(0, base.length - 4), 'end-record-missing');
  await rejectsCode(zip(validEntries(), { disk: 1 }), 'multi-disk-unsupported');
  await rejectsCode(zip(validEntries(), { entryCount: 0xffff }), 'zip64-unsupported');
});

test('rejects central-directory bounds, signatures, and entry-count caps', async () => {
  await rejectsCode(zip(validEntries(), { centralOffset: 0xffffffff }), 'zip64-unsupported');
  await rejectsCode(zip(validEntries(), { centralSize: 0xfffffffe }), 'central-directory-bounds');
  await rejectsCode(zip(validEntries(), { entryCount: VSIX_LIMITS.entries + 1 }), 'entry-limit');
  const damaged = zip(validEntries()); damaged[damaged.length - 22 - 46 - 'extension/themes/demo.json'.length] = 0;
  await assert.rejects(() => extractVsixThemes(damaged));
});

test('rejects CRC, declared length, and local-name mismatch', async () => {
  await rejectsCode(zip(validEntries().map((entry, index) => index ? entry : { ...entry, crc: 1 })), 'crc-mismatch');
  await rejectsCode(zip(validEntries().map((entry, index) => index ? entry : { ...entry, uncompressedSize: 999 })), 'size-mismatch');
  await rejectsCode(zip(validEntries().map((entry, index) => index ? entry : { ...entry, localName: 'extension/other.json' })), 'local-name-mismatch');
});

test('accepts data-descriptor flags when central metadata is complete', async () => {
  const entries = validEntries().map((entry) => ({ ...entry, flags: 0x0808 }));
  assert.equal((await extractVsixThemes(zip(entries))).themes.length, 1);
});

test('rejects non-ASCII names without the UTF-8 flag', async () => {
  await rejectsCode(zip([{ name: 'extension/thème.json', data: '{}', flags: 0 }]), 'entry-name-encoding');
});

test('rejects package and theme caps, expansion ratio, and too many contributions', async () => {
  await rejectsCode(zip([{ name: 'extension/package.json', data: 'x'.repeat(VSIX_LIMITS.packageBytes + 1) }]), 'package-too-large');
  const many = Array.from({ length: 17 }, (_, index) => ({ label: `T${index}`, path: `./themes/${index}.json` }));
  await rejectsCode(zip([{ name: 'extension/package.json', data: manifest(many) }]), 'theme-count-limit');
  const largeTheme = 'x'.repeat(VSIX_LIMITS.themeBytes + 1);
  await rejectsCode(zip([
    { name: 'extension/package.json', data: manifest(), method: 8 },
    { name: 'extension/themes/demo.json', data: largeTheme, method: 8 },
  ]), 'theme-too-large');
  const ratioBomb = validEntries(8).map((entry, index) => index ? { ...entry, data: 'a'.repeat(20000) } : entry);
  await rejectsCode(zip(ratioBomb), 'expansion-ratio');
});

test('rejects malformed package objects and theme paths outside extension', async () => {
  await rejectsCode(zip([{ name: 'extension/package.json', data: '[]' }]), 'manifest-invalid');
  await rejectsCode(zip([{ name: 'extension/package.json', data: manifest([{ label: 'Bad', path: '../bad.json' }]) }]), 'theme-path-invalid');
});

test('bounded mutation sweep never hangs or leaks RangeError', async () => {
  const fixture = zip(validEntries(8));
  for (const index of [0, 3, 10, 29, fixture.length - 23, fixture.length - 5]) {
    const mutated = fixture.slice(); mutated[index] ^= 0xff;
    try { await extractVsixThemes(mutated); } catch (error) {
      assert.ok(error?.code, `mutation ${index} must return a structured error`);
      assert.notEqual(error?.name, 'RangeError');
    }
  }
  for (const cut of [1, 8, 21, 40]) {
    await assert.rejects(() => extractVsixThemes(fixture.slice(0, fixture.length - cut)), (error) => error?.code && error.name !== 'RangeError');
  }
});

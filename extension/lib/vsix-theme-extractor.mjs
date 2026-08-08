export const VSIX_LIMITS = Object.freeze({
  archiveBytes: 20 * 1024 * 1024,
  entries: 4096,
  packageBytes: 256 * 1024,
  themeBytes: 512 * 1024,
  themeCount: 16,
  totalThemeBytes: 4 * 1024 * 1024,
  ratio: 100,
  endScanBytes: 65_557,
});

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const decoder = new TextDecoder('utf-8', { fatal: true });

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw failure('archive-invalid', 'VSIX input must be binary data');
}

function requireRange(bytes, offset, length, code = 'archive-truncated') {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw failure(code, 'VSIX structure exceeds archive bounds');
  }
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function read16(view, bytes, offset) { requireRange(bytes, offset, 2); return view.getUint16(offset, true); }
function read32(view, bytes, offset) { requireRange(bytes, offset, 4); return view.getUint32(offset, true); }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(input) {
  const bytes = bytesOf(input);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeName(bytes, flags) {
  const nonAscii = bytes.some((byte) => byte > 0x7f);
  if (nonAscii && !(flags & 0x0800)) throw failure('entry-name-encoding', 'Non-ASCII ZIP entry names require UTF-8');
  try { return decoder.decode(bytes); } catch { throw failure('entry-name-encoding', 'ZIP entry name is not valid UTF-8'); }
}

function validatePath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name)) {
    throw failure('invalid-entry-path', 'ZIP entry path is unsafe');
  }
  const segments = name.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) throw failure('invalid-entry-path', 'ZIP entry path is unsafe');
  return name;
}

function findEocd(bytes, view) {
  const start = Math.max(0, bytes.length - VSIX_LIMITS.endScanBytes);
  const matches = [];
  for (let offset = start; offset + 22 <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) === EOCD) matches.push(offset);
  }
  if (!matches.length) throw failure('end-record-missing', 'ZIP end record is missing');
  if (matches.length !== 1) throw failure('end-record-duplicate', 'ZIP contains duplicate end records');
  const offset = matches[0];
  const commentLength = read16(view, bytes, offset + 20);
  if (offset + 22 + commentLength !== bytes.length) throw failure('end-record-invalid', 'ZIP end record length is invalid');
  const disk = read16(view, bytes, offset + 4);
  const centralDisk = read16(view, bytes, offset + 6);
  const diskEntries = read16(view, bytes, offset + 8);
  const entries = read16(view, bytes, offset + 10);
  const centralSize = read32(view, bytes, offset + 12);
  const centralOffset = read32(view, bytes, offset + 16);
  if (disk || centralDisk || diskEntries !== entries) throw failure('multi-disk-unsupported', 'Multi-disk ZIP archives are unsupported');
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw failure('zip64-unsupported', 'ZIP64 archives are unsupported');
  if (entries > VSIX_LIMITS.entries) throw failure('entry-limit', 'ZIP entry count exceeds the limit');
  if (centralOffset + centralSize > offset) throw failure('central-directory-bounds', 'ZIP central directory exceeds archive bounds');
  return { offset, entries, centralOffset, centralSize };
}

function readDirectory(bytes, view, end) {
  const records = new Map();
  let offset = end.centralOffset;
  const directoryEnd = end.centralOffset + end.centralSize;
  for (let index = 0; index < end.entries; index += 1) {
    requireRange(bytes, offset, 46);
    if (read32(view, bytes, offset) !== CENTRAL) throw failure('central-signature', 'ZIP central-directory signature is invalid');
    const flags = read16(view, bytes, offset + 8);
    const method = read16(view, bytes, offset + 10);
    const checksum = read32(view, bytes, offset + 16);
    const compressedSize = read32(view, bytes, offset + 20);
    const uncompressedSize = read32(view, bytes, offset + 24);
    const nameLength = read16(view, bytes, offset + 28);
    const extraLength = read16(view, bytes, offset + 30);
    const commentLength = read16(view, bytes, offset + 32);
    const localOffset = read32(view, bytes, offset + 42);
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw failure('zip64-unsupported', 'ZIP64 entry metadata is unsupported');
    requireRange(bytes, offset + 46, nameLength + extraLength + commentLength);
    const name = validatePath(decodeName(bytes.slice(offset + 46, offset + 46 + nameLength), flags));
    if (records.has(name)) throw failure('duplicate-entry', 'ZIP contains duplicate entry names');
    if (flags & 1) throw failure('encrypted-entry', 'Encrypted ZIP entries are unsupported');
    records.set(name, { name, flags, method, checksum, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryEnd) throw failure('central-directory-size', 'ZIP central-directory size does not match its entries');
  return records;
}

async function inflateBounded(compressed, expected, cap) {
  if (typeof globalThis.DecompressionStream !== 'function') throw failure('deflate-unavailable', 'Deflate decompression is unavailable');
  let stream;
  try { stream = new Blob([compressed]).stream().pipeThrough(new globalThis.DecompressionStream('deflate-raw')); }
  catch { throw failure('deflate-failed', 'Could not initialize ZIP decompression'); }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap || total > expected) {
        await reader.cancel();
        throw failure('size-mismatch', 'Decompressed entry exceeds its declared or permitted size');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.code) throw error;
    throw failure('deflate-failed', 'ZIP entry decompression failed');
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function extractEntry(bytes, view, end, record, cap, capCode) {
  if (record.uncompressedSize > cap) throw failure(capCode, 'Required ZIP entry exceeds its size limit');
  if (record.compressedSize === 0 && record.uncompressedSize > 0) throw failure('expansion-ratio', 'ZIP entry expansion ratio exceeds the limit');
  if (record.compressedSize > 0 && record.uncompressedSize / record.compressedSize > VSIX_LIMITS.ratio) throw failure('expansion-ratio', 'ZIP entry expansion ratio exceeds the limit');
  if (![0, 8].includes(record.method)) throw failure('unsupported-compression', 'Required ZIP entry uses unsupported compression');
  requireRange(bytes, record.localOffset, 30);
  if (read32(view, bytes, record.localOffset) !== LOCAL) throw failure('local-signature', 'ZIP local header signature is invalid');
  const localFlags = read16(view, bytes, record.localOffset + 6);
  const localMethod = read16(view, bytes, record.localOffset + 8);
  const nameLength = read16(view, bytes, record.localOffset + 26);
  const extraLength = read16(view, bytes, record.localOffset + 28);
  requireRange(bytes, record.localOffset + 30, nameLength + extraLength);
  const localName = decodeName(bytes.slice(record.localOffset + 30, record.localOffset + 30 + nameLength), localFlags);
  if (localName !== record.name) throw failure('local-name-mismatch', 'ZIP local and central entry names differ');
  if (localMethod !== record.method || ((localFlags ^ record.flags) & 0x0809)) throw failure('local-header-mismatch', 'ZIP local and central metadata differ');
  const payloadOffset = record.localOffset + 30 + nameLength + extraLength;
  requireRange(bytes, payloadOffset, record.compressedSize);
  if (payloadOffset + record.compressedSize > end.centralOffset) throw failure('payload-bounds', 'ZIP payload overlaps the central directory');
  const compressed = bytes.slice(payloadOffset, payloadOffset + record.compressedSize);
  const plain = record.method === 0 ? compressed : await inflateBounded(compressed, record.uncompressedSize, cap);
  if (plain.length !== record.uncompressedSize) throw failure('size-mismatch', 'ZIP entry length does not match its declaration');
  if (crc32(plain) !== record.checksum) throw failure('crc-mismatch', 'ZIP entry checksum is invalid');
  return plain;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function resolveThemePath(path) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[a-z]:/i.test(path)) {
    throw failure('theme-path-invalid', 'Contributed theme path is unsafe');
  }
  const parts = path.replace(/^\.\//, '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw failure('theme-path-invalid', 'Contributed theme path escapes the extension directory');
  return validatePath(`extension/${parts.join('/')}`);
}

export async function extractVsixThemes(input) {
  const bytes = bytesOf(input);
  if (bytes.length > VSIX_LIMITS.archiveBytes) throw failure('archive-too-large', 'VSIX archive exceeds the byte limit');
  const view = viewOf(bytes);
  const end = findEocd(bytes, view);
  const records = readDirectory(bytes, view, end);
  const packageRecord = records.get('extension/package.json');
  if (!packageRecord) throw failure('manifest-missing', 'VSIX package manifest is missing');
  const packageBytes = await extractEntry(bytes, view, end, packageRecord, VSIX_LIMITS.packageBytes, 'package-too-large');
  let manifest;
  try { manifest = JSON.parse(decoder.decode(packageBytes)); } catch { throw failure('manifest-invalid', 'VSIX package manifest is invalid JSON'); }
  if (!plainObject(manifest)) throw failure('manifest-invalid', 'VSIX package manifest must be a plain object');
  const contributions = manifest.contributes?.themes;
  if (!Array.isArray(contributions) || contributions.length === 0) throw failure('no-color-themes', 'VSIX package contributes no color themes');
  if (contributions.length > VSIX_LIMITS.themeCount) throw failure('theme-count-limit', 'VSIX package contributes too many color themes');
  const themes = [];
  let total = 0;
  for (const contribution of contributions) {
    if (!plainObject(contribution)) throw failure('manifest-invalid', 'VSIX theme contribution must be a plain object');
    const entryName = resolveThemePath(contribution.path);
    const record = records.get(entryName);
    if (!record) throw failure('theme-file-missing', 'VSIX referenced theme file is missing');
    if (record.uncompressedSize > VSIX_LIMITS.themeBytes) throw failure('theme-too-large', 'VSIX theme file exceeds the byte limit');
    total += record.uncompressedSize;
    if (total > VSIX_LIMITS.totalThemeBytes) throw failure('theme-total-too-large', 'VSIX extracted theme data exceeds the total limit');
    const themeBytes = await extractEntry(bytes, view, end, record, VSIX_LIMITS.themeBytes, 'theme-too-large');
    let contents;
    try { contents = decoder.decode(themeBytes); } catch { throw failure('theme-encoding', 'VSIX theme file is not valid UTF-8'); }
    themes.push({
      label: typeof contribution.label === 'string' ? contribution.label : '',
      uiTheme: typeof contribution.uiTheme === 'string' ? contribution.uiTheme : '',
      path: entryName,
      contents,
    });
  }
  return {
    packageName: typeof manifest.name === 'string' ? manifest.name : '',
    packageVersion: typeof manifest.version === 'string' ? manifest.version : '',
    themes,
  };
}

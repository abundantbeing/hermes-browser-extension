import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

const ICON_DIR = path.join(process.cwd(), 'extension', 'assets', 'icons');
const BRAVE_ICONS = [
  ['brave-nous-girl-16.png', 16],
  ['brave-nous-girl-32.png', 32],
  ['brave-nous-girl-48.png', 48],
  ['brave-nous-girl-128.png', 128],
];
const PNG_SIGNATURE = '89504e470d0a1a0a';

function pngInfo(filePath) {
  const buffer = readFileSync(filePath);
  assert.equal(
    buffer.subarray(0, 8).toString('hex'),
    PNG_SIGNATURE,
    `${filePath} must start with the PNG signature`,
  );
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.length,
  };
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

/** Decode a non-interlaced, 8-bit RGBA PNG without external image dependencies. */
function decodePngRgba(filePath) {
  const buffer = readFileSync(filePath);
  assert.equal(buffer.subarray(0, 8).toString('hex'), PNG_SIGNATURE, `${filePath} must be a PNG`);

  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlaceMethod;
  const idatChunks = [];

  while (offset < buffer.length) {
    assert.ok(offset + 12 <= buffer.length, `${filePath} has a truncated PNG chunk`);
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert.ok(dataEnd + 4 <= buffer.length, `${filePath} has a truncated ${type} chunk`);

    if (type === 'IHDR') {
      assert.equal(length, 13, `${filePath} must have a 13-byte IHDR`);
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      assert.equal(buffer[dataStart + 10], 0, `${filePath} must use PNG compression method 0`);
      assert.equal(buffer[dataStart + 11], 0, `${filePath} must use PNG filter method 0`);
      interlaceMethod = buffer[dataStart + 12];
    } else if (type === 'IDAT') {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  assert.ok(width && height, `${filePath} must include IHDR dimensions`);
  assert.equal(bitDepth, 8, `${filePath} must use 8-bit channels`);
  assert.equal(colorType, 6, `${filePath} must use RGBA color type 6`);
  assert.equal(interlaceMethod, 0, `${filePath} must be non-interlaced for deterministic decoding`);
  assert.ok(idatChunks.length > 0, `${filePath} must include image data`);

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const filtered = inflateSync(Buffer.concat(idatChunks));
  assert.equal(filtered.length, height * (stride + 1), `${filePath} has unexpected scanline data length`);

  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[sourceOffset];
    sourceOffset += 1;
    const rowStart = y * stride;
    const previousRowStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = filtered[sourceOffset + x];
      const left = x >= bytesPerPixel ? pixels[rowStart + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[previousRowStart + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[previousRowStart + x - bytesPerPixel] : 0;
      if (filter === 0) pixels[rowStart + x] = raw;
      else if (filter === 1) pixels[rowStart + x] = (raw + left) & 0xff;
      else if (filter === 2) pixels[rowStart + x] = (raw + above) & 0xff;
      else if (filter === 3) pixels[rowStart + x] = (raw + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) pixels[rowStart + x] = (raw + paethPredictor(left, above, upperLeft)) & 0xff;
      else assert.fail(`${filePath} uses unsupported PNG filter ${filter}`);
    }
    sourceOffset += stride;
  }

  return { width, height, pixels };
}

function iconPixelStats(filePath) {
  const { width, height, pixels } = decodePngRgba(filePath);
  let transparentPixels = 0;
  let nontransparentPixels = 0;
  let nearBlackPixels = 0;
  let nearWhitePixels = 0;

  for (let offset = 0; offset < pixels.length; offset += 4) {
    const [red, green, blue, alpha] = pixels.subarray(offset, offset + 4);
    if (alpha === 0) {
      transparentPixels += 1;
      continue;
    }
    nontransparentPixels += 1;
    if (red <= 48 && green <= 48 && blue <= 48) nearBlackPixels += 1;
    if (red >= 224 && green >= 224 && blue >= 224) nearWhitePixels += 1;
  }

  return { width, height, transparentPixels, nontransparentPixels, nearBlackPixels, nearWhitePixels };
}

test('Brave action icons are transparent dual-contrast Nous Girl RGBA assets', () => {
  for (const [fileName, size] of BRAVE_ICONS) {
    const filePath = path.join(ICON_DIR, fileName);
    assert.ok(existsSync(filePath), `${fileName} should exist`);
    const info = pngInfo(filePath);
    assert.equal(info.width, size, `${fileName} width must be ${size}`);
    assert.equal(info.height, size, `${fileName} height must be ${size}`);
    assert.ok(info.bytes > 100, `${fileName} must be larger than 100 bytes`);

    const stats = iconPixelStats(filePath);
    assert.equal(stats.width, size, `${fileName} decoded width must be ${size}`);
    assert.equal(stats.height, size, `${fileName} decoded height must be ${size}`);
    assert.ok(stats.transparentPixels >= Math.ceil(size * size * 0.1), `${fileName} must retain a meaningful transparent canvas`);
    assert.ok(stats.nearBlackPixels > 0, `${fileName} must retain the near-black Nous Girl core`);
    assert.ok(stats.nearWhitePixels > 0, `${fileName} must include a near-white outer keyline for dark Brave chrome`);
  }
});

test('both source manifests retain Alt+H and the generic boxed action icon', () => {
  const manifests = [
    JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')),
    JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')),
  ];
  for (const manifest of manifests) {
    assert.equal(manifest.commands._execute_action.suggested_key.default, 'Alt+H');
    for (const [size, iconPath] of Object.entries(manifest.action.default_icon)) {
      assert.match(iconPath, /icon-\d+\.png$/, `action icon ${size} must stay generic`);
    }
    assert.ok(
      !Object.values(manifest.action.default_icon).some((value) => value.includes('brave-nous-girl')),
      'manifest must keep the generic icon so the Nous Girl override is Brave-only at runtime',
    );
  }
});

test('background production source wires the browser-specific action icon helper', () => {
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(source, /setActionIconForBrowser/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { renderMarkdown } from '../extension/lib/common.mjs';
import { extractHistoryMediaAttachments } from '../extension/lib/image-render.mjs';
import {
  classifyMediaKind,
  extractImageRefs,
  extractMediaTagPaths,
  extractVideoRefs,
  extractVisionCachePaths,
  isHermesManagedMediaPath,
  resolveMediaFetchPlan,
  splitInboundVisionMessage,
} from '../extension/lib/media-persistence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('extractImageRefs finds @image refs with and without quotes', () => {
  const text = [
    'Working on it.',
    '@image:/home/hermes/images/img_20260910_145001_1.jpg',
    "@image:'/home/hermes/images/my pic.png'",
    'not-an-image: /home/x.jpg',
  ].join('\n');
  const refs = extractImageRefs(text);
  assert.deepEqual(refs.map((item) => item.path), [
    '/home/hermes/images/img_20260910_145001_1.jpg',
    '/home/hermes/images/my pic.png',
  ]);
  assert.equal(refs[0].ext, '.jpg');
});

test('extractVideoRefs parses @video tags only', () => {
  const refs = extractVideoRefs('clip ready\n@video:/h/cache/videos/clip_01.mp4\nMEDIA:/h/cache/images/x.png');
  assert.deepEqual(refs.map((item) => item.path), ['/h/cache/videos/clip_01.mp4']);
});

test('extractMediaTagPaths keeps local MEDIA image and video paths', () => {
  const paths = extractMediaTagPaths([
    'Done.',
    'MEDIA:D:\\Documents\\HBE MARKETING GFX\\Update Ads\\v0.3.2\\Video\\final\\Hermes Browser Extension v0.3.2 Release Video FINAL.mp4',
    'MEDIA:https://example.com/x.png',
  ].join('\n'));
  assert.equal(paths.length, 1);
  assert.match(paths[0].path, /Release Video FINAL\.mp4$/);
  assert.equal(paths[0].kind, 'video');
});

test('extractVisionCachePaths reads Telegram inbound vision_analyze image_url paths', () => {
  const text = [
    '[The user sent an image~ Here\'s what I can see:',
    'A mockup of group rooms.]',
    '[If you need a closer look, use vision_analyze with image_url: C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg ~]',
    '',
    'Please fix the animation',
  ].join('\n');
  const paths = extractVisionCachePaths(text);
  assert.deepEqual(paths, ['C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg']);
});

test('splitInboundVisionMessage keeps the user caption and drops the vision_analyze instruction', () => {
  const text = [
    '[The user sent an image~ Here\'s what I can see:',
    'A mockup of group rooms.]',
    '[If you need a closer look, use vision_analyze with image_url: C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg ~]',
    '',
    'Please fix the animation',
  ].join('\n');
  const split = splitInboundVisionMessage(text);
  assert.deepEqual(split.paths, ['C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg']);
  assert.equal(split.visibleText, 'Please fix the animation');
  assert.equal(split.hadVisionBlock, true);
});

test('classifyMediaKind sniffs image vs video vs other', () => {
  assert.equal(classifyMediaKind('x.PNG'), 'image');
  assert.equal(classifyMediaKind('clip.mp4'), 'video');
  assert.equal(classifyMediaKind('notes.txt'), 'other');
});

test('isHermesManagedMediaPath allows Hermes image/cache/screenshot roots only', () => {
  assert.equal(isHermesManagedMediaPath('C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg'), true);
  assert.equal(isHermesManagedMediaPath('/home/hermes/.hermes/images/up_1.png'), true);
  assert.equal(isHermesManagedMediaPath('D:\\Documents\\HBE MARKETING GFX\\clip.mp4'), false);
  assert.equal(isHermesManagedMediaPath('C:\\Windows\\System32\\config\\SAM'), false);
});

test('resolveMediaFetchPlan uses /api/media for managed images and stream for videos', () => {
  assert.deepEqual(
    resolveMediaFetchPlan({ pathRef: 'C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg' }),
    { transport: 'dashboard-media', endpoint: '/api/media', params: { path: 'C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg' } },
  );
  const videoPlan = resolveMediaFetchPlan({
    pathRef: 'D:\\Documents\\HBE MARKETING GFX\\Update Ads\\v0.3.2\\Video\\final\\Hermes Browser Extension v0.3.2 Release Video FINAL.mp4',
  });
  assert.equal(videoPlan.transport, 'dashboard-stream');
  assert.equal(videoPlan.endpoint, '/api/files/stream');
  assert.deepEqual(
    resolveMediaFetchPlan({ pathRef: '/etc/passwd' }),
    { transport: 'none', reason: 'path-not-media' },
  );
});

test('history extraction turns Telegram vision_url paths into image pathRefs', () => {
  const extracted = extractHistoryMediaAttachments({
    role: 'user',
    content: [
      '[The user sent an image~ Here\'s what I can see:',
      'A mockup.]',
      '[If you need a closer look, use vision_analyze with image_url: C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg ~]',
    ].join('\n'),
  });
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].kind, 'image');
  assert.equal(extracted[0].pathRef, 'C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg');
});

test('markdown MEDIA local video becomes a hydratable session-media placeholder, not an unavailable image', () => {
  const html = renderMarkdown('MEDIA:D:\\Documents\\HBE MARKETING GFX\\clip.mp4');
  assert.match(html, /data-session-media="video"/);
  assert.match(html, /data-media-path="/);
  assert.doesNotMatch(html, /generated-image-unavailable/);
});

test('markdown MEDIA local image becomes a hydratable session-media placeholder', () => {
  const html = renderMarkdown('MEDIA:C:\\Users\\Jaybo\\.hermes\\cache\\images\\img_26c20aef5209.jpg');
  assert.match(html, /data-session-media="image"/);
  assert.doesNotMatch(html, /generated-image-unavailable/);
});

test('sidepanel hydrates history media through the discovered dashboard /api/media and /api/files/stream', () => {
  const source = read('extension/sidepanel.js');
  assert.match(source, /hydrateSessionMedia/);
  assert.match(source, /fetchDashboardMediaDataUrl/);
  assert.match(source, /dashboardFileStreamUrl/);
});

test('Hermes Web hydrates session media with the same dashboard endpoints', () => {
  const source = read('extension/app.js');
  assert.match(source, /hydrateSessionMedia/);
  assert.match(source, /fetchDashboardMediaDataUrl/);
});

test('package check:js syntax-checks the media persistence module', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(String(pkg.scripts?.['check:js'] || ''), /media-persistence\.mjs/);
});

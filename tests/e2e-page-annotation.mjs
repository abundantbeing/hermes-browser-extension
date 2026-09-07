import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const html = readFileSync(path.join(ROOT, 'extension/sidepanel.html'), 'utf8');
assert.match(html, /data-attach="comment-page"/);
assert.match(html, /class="attach-menu-icon"/);
assert.match(html, /id="pageCommentTrayButton"/);
assert.doesNotMatch(html, /id="pageCommentComposerButton"/);

const css = readFileSync(path.join(ROOT, 'extension/sidepanel.css'), 'utf8');
assert.match(css, /\.attach-menu-icon\s*\{[^}]*display:\s*inline-block/s);
assert.doesNotMatch(css, /\.attach-menu button\s*\{[^}]*display:\s*flex/s);

const sidepanel = readFileSync(path.join(ROOT, 'extension/sidepanel.js'), 'utf8');
assert.match(sidepanel, /startElementPick\(\{ purpose: 'comment' \}\)/);
assert.match(sidepanel, /pageCommentPickActive/);
assert.match(sidepanel, /commitPageCommentFromCard/);
assert.match(sidepanel, /pageCommentTrayButton/);
assert.match(sidepanel, /PAGE_ANNOTATION_MESSAGES\.ABORT/);
assert.match(sidepanel, /pageCommentThemeFromPanel/);
assert.match(sidepanel, /els\.pageAnnotationPanel\) els\.pageAnnotationPanel\.hidden = true/);

const content = readFileSync(path.join(ROOT, 'extension/content.js'), 'utf8');
assert.match(content, /HermesPageAnnotation/);
assert.match(content, /mountPageCommentCard/);
assert.match(content, /data-hermes-pick-purpose/);
assert.match(content, /click an element to comment/);
assert.match(content, /abortPageOverlays/);

const runtime = readFileSync(path.join(ROOT, 'extension/content-extractor.js'), 'utf8');
assert.match(runtime, /HermesPageAnnotation/);
assert.match(runtime, /HERMES_START_PAGE_ANNOTATION/);

const domain = readFileSync(path.join(ROOT, 'extension/lib/page-annotation.mjs'), 'utf8');
assert.match(domain, /formatPageAnnotationFlush/);
assert.doesNotMatch(domain, /askHermes\(/);

assert.ok(existsSync(path.join(ROOT, 'extension/lib/screenshot-limits.mjs')));
assert.ok(existsSync(path.join(ROOT, 'extension/lib/page-annotation-capture.mjs')));
assert.ok(existsSync(path.join(ROOT, 'extension/lib/page-annotation-storage.mjs')));

console.log('page-annotation e2e structural checks passed');

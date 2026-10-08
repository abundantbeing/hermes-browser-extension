import assert from 'node:assert/strict';
import test from 'node:test';
import { fitComposerHeight, keepCaretInFrame, bindComposerFrame } from '../extension/lib/composer-autogrow.mjs';
import { JSDOM } from 'jsdom';

function area({ scrollHeight, clientHeight = 180, scrollTop = 0, style = {} }) {
  return { style, scrollHeight, clientHeight, scrollTop, clientWidth: 320, value: '', selectionEnd: 0 };
}

const borderBox = {
  boxSizing: 'border-box', maxHeight: '200px', minHeight: '76px',
  borderTopWidth: '1px', borderBottomWidth: '1px', paddingTop: '10px', paddingBottom: '44px',
};

test('field grows to content, includes borders, and stops at max height', () => {
  const field = area({ scrollHeight: 140 });
  assert.equal(fitComposerHeight(field, borderBox), 142);
  assert.equal(field.style.height, '142px');
  assert.equal(field.style.overflowY, 'hidden');
  field.scrollHeight = 480;
  fitComposerHeight(field, borderBox);
  assert.equal(field.style.height, '200px');
  assert.equal(field.style.overflowY, 'auto');
});

test('rows does not keep an empty field above its CSS minimum', () => {
  const field = area({ scrollHeight: 103 });
  Object.defineProperty(field, 'scrollHeight', { get() { return field.style.height === '0px' ? 70 : 103; } });
  fitComposerHeight(field, borderBox);
  assert.equal(field.style.height, '76px');
});

test('field shrinks to content but never below min height', () => {
  const field = area({ scrollHeight: 90 });
  field.style.height = '180px';
  fitComposerHeight(field, borderBox);
  assert.equal(field.style.height, '92px');
  field.scrollHeight = 20;
  fitComposerHeight(field, borderBox);
  assert.equal(field.style.height, '76px');
  assert.equal(field.style.overflowY, 'hidden');
});

test('content-box sizing excludes padding and an absent max does not cap growth', () => {
  const field = area({ scrollHeight: 180 });
  const contentBox = { ...borderBox, boxSizing: 'content-box', maxHeight: 'none' };
  assert.equal(fitComposerHeight(field, contentBox), 126);
  assert.equal(field.style.overflowY, 'hidden');
});

test('caret stays fully above the commands chip', () => {
  const field = area({ clientHeight: 180, scrollTop: 0 });
  keepCaretInFrame(field, { caretTop: 640, caretHeight: 17, chipClearance: 44, topClearance: 10 });
  assert.equal(field.scrollTop, 521);
  assert.ok(640 - field.scrollTop >= 10);
  assert.ok(640 + 17 - field.scrollTop <= 180 - 44);
});

test('caret already in frame and manual upward scrolling are left untouched', () => {
  const field = area({ clientHeight: 180, scrollTop: 40 });
  keepCaretInFrame(field, { caretTop: 70, caretHeight: 17, chipClearance: 30, topClearance: 8 });
  assert.equal(field.scrollTop, 40);
});

test('caret above the visible area scrolls back without going negative', () => {
  const field = area({ clientHeight: 180, scrollTop: 400 });
  keepCaretInFrame(field, { caretTop: 2, caretHeight: 16, chipClearance: 44, topClearance: 10 });
  assert.equal(field.scrollTop, 0);
});

test('unchanged render preserves a manual resize and scroll position', () => {
  const dom = new JSDOM('<textarea style="box-sizing:border-box;min-height:76px;max-height:200px;padding:10px 68px 44px 36px;font:12px/16px monospace;border:1px solid"></textarea>');
  const field = dom.window.document.querySelector('textarea');
  Object.defineProperties(field, {
    scrollHeight: { get: () => 70 },
    clientWidth: { get: () => 320 },
    clientHeight: { get: () => 178 },
  });
  field.getBoundingClientRect = () => ({ width: 322, height: Number.parseFloat(field.style.height) || 76 });
  const frame = bindComposerFrame(field);
  frame.sync();
  field.style.height = '150px';
  field.scrollTop = 20;
  frame.sync();
  assert.equal(field.style.height, '150px');
  assert.equal(field.scrollTop, 20);
  field.value = 'a new draft';
  frame.sync();
  assert.equal(field.style.height, '76px', 'a text edit resumes autogrow');
  frame.disconnect();
  dom.window.close();
});

test('glass state follows whether draft text is hidden below the controls', () => {
  const dom = new JSDOM('<div class="composer-input-wrap"><textarea style="box-sizing:border-box;min-height:76px;max-height:200px;padding:10px 68px 44px 36px;font:12px/16px monospace;border:1px solid"></textarea></div>');
  const field = dom.window.document.querySelector('textarea');
  const wrap = field.parentElement;
  let scrollHeight = 600;
  Object.defineProperties(field, {
    scrollHeight: { get: () => scrollHeight },
    clientWidth: { get: () => 320 },
    clientHeight: { get: () => 198 },
  });
  field.getBoundingClientRect = () => ({ width: 322, height: Number.parseFloat(field.style.height) || 76 });
  const frame = bindComposerFrame(field);
  field.value = 'a long draft';
  field.scrollTop = 0;
  frame.sync();
  field.scrollTop = 0;
  field.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(wrap.classList.contains('composer-text-below'), 'scrolled up: text passes under the controls');
  field.scrollTop = 600 - 198;
  field.dispatchEvent(new dom.window.Event('scroll'));
  assert.ok(!wrap.classList.contains('composer-text-below'), 'at the end: nothing under the controls');
  field.scrollTop = 0;
  scrollHeight = 120;
  field.value = 'short';
  frame.sync();
  assert.ok(!wrap.classList.contains('composer-text-below'), 'a short draft never shows glass');
  frame.disconnect();
  dom.window.close();
});

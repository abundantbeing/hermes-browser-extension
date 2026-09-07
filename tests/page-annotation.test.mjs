import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_ANNOTATION_COMMENTS_ENABLED,
  PAGE_ANNOTATION_FEATURE_STORAGE_KEY,
  PAGE_ANNOTATION_SCHEMA_VERSION,
  addPageAnnotation,
  compactPageAnnotationIdentity,
  emptyPageAnnotationStack,
  formatPageAnnotationFlush,
  formatPageCommentTargetLabel,
  groupPageAnnotations,
  mergePageAnnotationComposerState,
  normalizePageAnnotationResult,
  packagePageAnnotation,
  pageAnnotationBundleFingerprint,
  pageAnnotationCommentsEnabled,
  pageCommentVisibleText,
  queuePageAnnotationTurn,
  removePageAnnotation,
  restorePageAnnotationBundleAfterFailure,
  updatePageAnnotationNote,
} from '../extension/lib/page-annotation.mjs';

const session = {
  sessionId: 'session-a',
  tabId: 42,
  safeUrl: 'https://example.test/path',
  documentKey: 'doc-1',
};

function elementDraft(overrides = {}) {
  return {
    kind: 'element',
    page: {
      tabId: 42,
      safeUrl: 'https://example.test/path',
      title: 'Example page',
      documentKey: 'doc-1',
      frameId: 0,
    },
    target: {
      selector: 'main > section:nth-of-type(1) > button',
      tag: 'button',
      text: 'Save changes',
      html: '<button class="primary">Save changes</button>',
      css: { color: 'rgb(17, 17, 17)', 'background-color': 'rgb(47, 128, 237)' },
    },
    rect: { x: 100, y: 240, width: 120, height: 40 },
    viewport: { width: 1440, height: 900, devicePixelRatio: 1, scrollX: 0, scrollY: 180 },
    imageRef: 'session-a/annotation-1',
    note: 'Make this button more prominent.',
    ...overrides,
  };
}

test('feature gate can be disabled via stored value', () => {
  assert.equal(PAGE_ANNOTATION_COMMENTS_ENABLED, true);
  assert.equal(PAGE_ANNOTATION_FEATURE_STORAGE_KEY, 'hermes:pageAnnotationCommentsEnabled');
  assert.equal(pageAnnotationCommentsEnabled({ storedValue: true }), true);
  assert.equal(pageAnnotationCommentsEnabled({ testOverride: true }), true);
  assert.equal(pageAnnotationCommentsEnabled({ storedValue: false }), false);
  assert.equal(pageAnnotationCommentsEnabled({}), true);
});

test('empty stack starts at comment 1', () => {
  const stack = emptyPageAnnotationStack(session);
  assert.equal(stack.nextNumber, 1);
  assert.deepEqual(stack.pins, []);
  assert.equal(stack.sessionId, 'session-a');
});

test('addPageAnnotation assigns stable ids and numbers', () => {
  let stack = emptyPageAnnotationStack(session);
  stack = addPageAnnotation(stack, elementDraft());
  stack = addPageAnnotation(stack, elementDraft({
    note: 'Second',
    target: { ...elementDraft().target, selector: 'footer > a', tag: 'a', text: 'Docs' },
  }));
  assert.equal(stack.pins[0].id, 'annotation-1');
  assert.equal(stack.pins[0].number, 1);
  assert.equal(stack.pins[1].id, 'annotation-2');
  assert.equal(stack.pins[1].number, 2);
  assert.equal(stack.nextNumber, 3);
});

test('updatePageAnnotationNote preserves number and id', () => {
  let stack = addPageAnnotation(emptyPageAnnotationStack(session), elementDraft());
  stack = updatePageAnnotationNote(stack, 'annotation-1', '  tighter copy  ');
  assert.equal(stack.pins[0].id, 'annotation-1');
  assert.equal(stack.pins[0].number, 1);
  assert.equal(stack.pins[0].note, 'tighter copy');
});

test('removePageAnnotation leaves later numbers unchanged', () => {
  let stack = emptyPageAnnotationStack(session);
  stack = addPageAnnotation(stack, elementDraft());
  stack = addPageAnnotation(stack, elementDraft({ note: 'Keep me' }));
  stack = removePageAnnotation(stack, 'annotation-1');
  assert.equal(stack.pins.length, 1);
  assert.equal(stack.pins[0].id, 'annotation-2');
  assert.equal(stack.pins[0].number, 2);
  assert.equal(stack.nextNumber, 3);
});

test('normalizePageAnnotationResult rejects foreign tab, url, session, and document', () => {
  const raw = {
    version: PAGE_ANNOTATION_SCHEMA_VERSION,
    sessionId: 'session-a',
    documentKey: 'doc-1',
    tabId: 42,
    kind: 'element',
    pageUrl: 'https://example.test/path',
    pageTitle: 'Example page',
    frameId: 0,
    rect: { x: 1, y: 2, width: 10, height: 10 },
    viewport: { width: 100, height: 100, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    identity: { selector: 'button', tag: 'button', text: 'Go', html: '<button>Go</button>', css: {} },
  };
  assert.ok(normalizePageAnnotationResult(raw, session));
  assert.equal(normalizePageAnnotationResult({ ...raw, sessionId: 'other' }, session), null);
  assert.equal(normalizePageAnnotationResult({ ...raw, documentKey: 'other' }, session), null);
  assert.equal(normalizePageAnnotationResult({ ...raw, pageUrl: 'https://evil.test/' }, session), null);
  assert.equal(normalizePageAnnotationResult({ ...raw, tabId: 99 }, session), null);
});

test('area results never invent a selector', () => {
  const result = normalizePageAnnotationResult({
    version: 1,
    sessionId: 'session-a',
    documentKey: 'doc-1',
    kind: 'area',
    pageUrl: 'https://example.test/path',
    pageTitle: 'Example page',
    frameId: 0,
    rect: { x: 8, y: 9, width: 40, height: 20 },
    viewport: { width: 100, height: 100, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    identity: { selector: 'div.nearby', tag: 'div', text: 'nope', html: '<div></div>', css: {} },
  }, session);
  assert.equal(result.kind, 'area');
  assert.equal(result.target, null);
});

test('compact identity clips desktop budgets and drops empty CSS', () => {
  const identity = compactPageAnnotationIdentity({
    tag: 'BUTTON',
    selector: 'a'.repeat(200),
    text: `  ${'word '.repeat(40)}  `,
    html: `<div>${'x'.repeat(700)}</div>`,
    css: {
      color: 'rgb(17, 17, 17)',
      display: 'none',
      margin: '0px',
      'font-size': '16px',
    },
  });
  assert.equal(identity.tag, 'button');
  assert.equal(identity.selector.length, 180);
  assert.equal(identity.text.length, 80);
  assert.equal(identity.html.length, 600);
  assert.equal(identity.css.color, 'rgb(17, 17, 17)');
  assert.equal(identity.css.display, undefined);
  assert.equal(identity.css.margin, undefined);
});

test('packagePageAnnotation uses desktop prompt order', () => {
  const packed = packagePageAnnotation(addPageAnnotation(emptyPageAnnotationStack(session), elementDraft()).pins[0]);
  assert.equal(packed.prompt, [
    'Comment 1',
    'Target: button "Save changes"',
    'Selector: main > section:nth-of-type(1) > button',
    'HTML: <button class="primary">Save changes</button>',
    'Styles: color: rgb(17, 17, 17); background-color: rgb(47, 128, 237)',
    'Note: Make this button more prominent.',
    'Image 1 marks the target in blue.',
  ].join('\n'));
});

test('formatPageAnnotationFlush stays flat below four comments', () => {
  let stack = emptyPageAnnotationStack(session);
  stack = addPageAnnotation(stack, elementDraft());
  stack = addPageAnnotation(stack, elementDraft({ note: 'Two' }));
  const prompt = formatPageAnnotationFlush(stack.pins, session.safeUrl);
  assert.match(prompt, /I left 2 comments on https:\/\/example\.test\/path in the browser tab/);
  assert.doesNotMatch(prompt, /Group 1/);
  assert.doesNotMatch(prompt, /askHermes/);
});

test('groupPageAnnotations splits by ancestor and parks area pins last', () => {
  let stack = emptyPageAnnotationStack(session);
  stack = addPageAnnotation(stack, elementDraft({
    target: { selector: 'main > hero > h1', tag: 'h1', text: 'Hello', html: '<h1>Hello</h1>', css: {} },
  }));
  stack = addPageAnnotation(stack, elementDraft({
    target: { selector: 'main > hero > p', tag: 'p', text: 'Body', html: '<p>Body</p>', css: {} },
  }));
  stack = addPageAnnotation(stack, elementDraft({
    target: { selector: 'footer > a', tag: 'a', text: 'Docs', html: '<a>Docs</a>', css: {} },
  }));
  stack = addPageAnnotation(stack, { ...elementDraft(), kind: 'area', target: null, note: 'This band' });
  const items = stack.pins.map(packagePageAnnotation);
  const groups = groupPageAnnotations(items);
  assert.ok(groups.length >= 2);
  assert.equal(groups.at(-1).label, '');
  assert.equal(groups.at(-1).items.length, 1);
  const prompt = formatPageAnnotationFlush(stack.pins, session.safeUrl);
  assert.match(prompt, /Work them as/);
});

test('composer merge replaces the previous extension-owned bundle', () => {
  const first = {
    sessionId: 'session-a',
    revision: 1,
    text: 'I left a comment on https://example.test/path in the browser tab.\n\nComment 1\nNote: first',
    attachments: [{ id: 'ann-session-a-1', kind: 'image', label: 'Comment_1.png', dataUrl: 'data:image/png;base64,aaa', source: 'page-annotations', annotationSessionId: 'session-a', annotationRevision: 1 }],
  };
  const second = {
    sessionId: 'session-a',
    revision: 2,
    text: 'I left a comment on https://example.test/path in the browser tab.\n\nComment 1\nNote: second',
    attachments: [{ id: 'ann-session-a-2', kind: 'image', label: 'Comment_1.png', dataUrl: 'data:image/png;base64,bbb', source: 'page-annotations', annotationSessionId: 'session-a', annotationRevision: 2 }],
  };
  const merged = mergePageAnnotationComposerState({ text: 'Keep this', attachments: [{ id: 'user-1', kind: 'file', label: 'notes.md' }] }, first);
  assert.match(merged.text, /Keep this/);
  assert.equal(merged.attachments.length, 2);
  const replaced = mergePageAnnotationComposerState(merged, second);
  assert.equal(replaced.attachments.filter((item) => item.source === 'page-annotations').length, 1);
  assert.match(replaced.text, /Note: second/);
  assert.doesNotMatch(replaced.text, /Note: first/);
  assert.equal(replaced.attachments.some((item) => item.id === 'user-1'), true);
});

test('queuePageAnnotationTurn uses existing queued-turn shape and never auto-asks', () => {
  const turn = queuePageAnnotationTurn({
    sessionId: 'session-a',
    revision: 3,
    text: 'comments',
    attachments: [{ id: 'ann-1', kind: 'image', label: 'Comment_1.png' }],
  });
  assert.equal(turn.kind, 'queued');
  assert.equal(turn.autoSend, true);
  assert.equal(turn.source, 'page-annotations');
  assert.equal(turn.annotationSessionId, 'session-a');
  assert.equal(turn.text, 'comments');
});

test('failed send restores the annotation bundle', () => {
  const restored = restorePageAnnotationBundleAfterFailure(
    { sessionId: 'session-a', revision: 1, text: 'comments', attachments: [{ id: 'ann-1' }] },
    new Error('gateway down'),
  );
  assert.equal(restored.retained, true);
  assert.equal(restored.queuedTurn.source, 'page-annotations');
  assert.match(restored.error, /gateway down/);
});

test('bundle fingerprint is stable for the same revision', () => {
  const stack = addPageAnnotation(emptyPageAnnotationStack(session), elementDraft());
  assert.equal(pageAnnotationBundleFingerprint(stack.pins), pageAnnotationBundleFingerprint(stack.pins));
});

test('comment target labels prefer readable text over selector soup', () => {
  assert.equal(
    formatPageCommentTargetLabel({
      tag: 'div',
      text: 'For you Following',
      selector: 'div#react-root > div > main > div',
    }),
    'For you Following',
  );
  assert.equal(
    formatPageCommentTargetLabel({ tag: 'div', selector: 'div#react-root > main > div.primaryColumn' }),
    'div.primaryColumn',
  );
  assert.equal(formatPageCommentTargetLabel({ tag: 'button' }), 'button');
});

test('visible comment text hides the prompt dump', () => {
  const dump = [
    'please fix this',
    '<<<HERMES_PAGE_COMMENTS session=page-annotation-1 revision=annotation-1:1:hi:x>>>',
    'Comment 1',
    'Note: hi',
    '<<<END_HERMES_PAGE_COMMENTS>>>',
  ].join('\n');
  assert.equal(pageCommentVisibleText(dump), 'please fix this');
  assert.equal(
    pageCommentVisibleText('<<<HERMES_PAGE_COMMENTS x>>>\nComment 1\nComment 2\n<<<END_HERMES_PAGE_COMMENTS>>>'),
    '2 page comments',
  );
});

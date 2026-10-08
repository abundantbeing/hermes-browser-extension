import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(client) {
  await client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function waitFor(check, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}

// Read the real browser's textarea editor, not the mirror being tested.
async function nativeCaret(client) {
  const doc = await client.call('DOM.getDocument', { depth: 1 });
  const { nodeId } = await client.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#promptInput' });
  const { node } = await client.call('DOM.describeNode', { nodeId, depth: -1, pierce: true });
  const editor = node.shadowRoots?.find(root => root.shadowRootType === 'user-agent')?.children
    ?.find(child => child.nodeName === 'DIV' && !(child.attributes || []).includes('placeholder'));
  assert.ok(editor, 'native textarea editor is available over CDP');
  const { object } = await client.call('DOM.resolveNode', { backendNodeId: editor.backendNodeId });
  try {
    const result = await client.call('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const area = document.querySelector('#promptInput');
        const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
        let remaining = area.selectionDirection === 'backward' ? area.selectionStart : area.selectionEnd;
        let node, lastText = null;
        while ((node = walker.nextNode())) {
          if (node.nodeType === Node.TEXT_NODE) {
            lastText = node;
            if (remaining <= node.textContent.length) {
              const range = document.createRange();
              range.setStart(node, remaining); range.collapse(true);
              const rect = range.getBoundingClientRect();
              if (rect.height) return { top: rect.top, bottom: rect.bottom, height: rect.height, left: rect.left };
            }
            remaining -= node.textContent.length;
          } else if (node.tagName === 'BR') {
            remaining -= 1;
          }
        }
        if (lastText) {
          const range = document.createRange();
          range.selectNodeContents(lastText); range.collapse(false);
          const rect = range.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height, left: rect.left };
        }
        return null;
      }`,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  } finally {
    await client.call('Runtime.releaseObject', { objectId: object.objectId });
  }
}

async function metrics(client) {
  const data = await client.evaluate(`(() => {
    const area = document.querySelector('#promptInput'); const cs = getComputedStyle(area);
    const rect = area.getBoundingClientRect();
    const controls = ['#commandMenuButton', '#attachMenuButton', '#voiceButton', '#inlineSendButton', '#stopButton', '#steerButton', '#queueButton']
      .map(s => document.querySelector(s)).filter(el => el && !el.hidden && el.getBoundingClientRect().height)
      .map(el => ({ id: el.id, top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }));
    const dock = document.querySelector('.bottom-dock').getBoundingClientRect();
    const footer = document.querySelector('.composer-actions').getBoundingClientRect();
    return {
      length: area.value.length, selection: area.selectionEnd, height: rect.height, top: rect.top, bottom: rect.bottom,
      clientHeight: area.clientHeight, scrollHeight: area.scrollHeight, scrollTop: area.scrollTop,
      maxHeight: parseFloat(cs.maxHeight), minHeight: parseFloat(cs.minHeight), paddingBottom: parseFloat(cs.paddingBottom),
      borderTop: parseFloat(cs.borderTopWidth), borderBottom: parseFloat(cs.borderBottomWidth),
      fontSize: cs.fontSize, lineHeight: parseFloat(cs.lineHeight), resize: cs.resize,
      controls, dockBottom: dock.bottom, footerTop: footer.top, footerBottom: footer.bottom, viewport: innerHeight,
    };
  })()`);
  data.nativeCaret = await nativeCaret(client);
  return data;
}

function assertFrame(data, label) {
  assert.ok(data.nativeCaret?.height > 0, `${label}: actual caret rectangle exists`);
  const bottomLimit = data.bottom - data.borderBottom - data.paddingBottom;
  assert.ok(data.nativeCaret.bottom <= bottomLimit + 2, `${label}: caret bottom ${data.nativeCaret.bottom} exceeds ${bottomLimit}`);
  assert.ok(data.nativeCaret.top >= data.top + data.borderTop - 2, `${label}: caret is above textarea`);
  for (const control of data.controls) {
    assert.ok(data.nativeCaret.bottom < control.top, `${label}: caret overlaps ${control.id}`);
  }
  assert.ok(data.height <= data.maxHeight + 1, `${label}: height cap`);
  assert.ok(data.footerTop >= data.bottom, `${label}: footer below textarea`);
  assert.ok(data.footerBottom <= data.viewport + 1 && data.dockBottom <= data.viewport + 1, `${label}: dock stays in viewport`);
}

async function empty(client) {
  await client.evaluate(`(() => { const a = document.querySelector('#promptInput'); a.focus(); a.select(); })()`);
  await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await settle(client);
}

export async function verifyComposerAutogrow({ client, worker, saveScreenshot, openPanel, baseline = false }) {
  const qaDir = path.resolve(import.meta.dirname, '..', '.hermes', 'qa', 'composer-autogrow');
  await mkdir(qaDir, { recursive: true });
  await waitFor(() => client.evaluate(`document.querySelector('#startupScreen')?.hidden && !document.querySelector('#promptInput')?.disabled`), 'panel ready');
  await settle(client);
  const report = { baseline, checks: [], screenshots: [] };
  const text = 'The composer grows as this draft gets longer. Older lines remain available while the latest sentence stays above the commands button. '.repeat(5).slice(0, 600);
  const capture = async (name, checkFrame = true) => {
    await settle(client);
    const data = await metrics(client);
    report.checks.push({ name, ...data });
    console.log('[composer-qa]', name, JSON.stringify({ height: data.height, scrollTop: data.scrollTop }));
    const filename = path.join(qaDir, `${name}.png`);
    await saveScreenshot(client, filename);
    report.screenshots.push(filename);
    await writeFile(path.join(qaDir, baseline ? 'before.json' : 'report.json'), JSON.stringify(report, null, 2));
    if (checkFrame) assertFrame(data, name);
    return data;
  };

  if (process.env.COMPOSER_QA_RESTORE_ONLY !== '1') {
    await empty(client);
    const startHeight = await client.evaluate('document.querySelector("#promptInput").getBoundingClientRect().height');
    for (let offset = 0; offset < text.length; offset += 60) {
      await client.call('Input.insertText', { text: text.slice(offset, offset + 60) });
      await settle(client);
      if (!baseline) assertFrame(await metrics(client), `typing-${offset}`);
    }
    const typed = await capture(baseline ? 'before-typing' : '01-typing', !baseline);
    if (baseline) return report;
    assert.equal(typed.length, 600);
    assert.ok(typed.height > startHeight, 'typing grows the field');

    await empty(client);
    const pasted = 'A pasted paragraph must wrap correctly and keep its final line visible. '.repeat(60).slice(0, 4000);
    await client.call('Input.insertText', { text: pasted });
    const paste = await capture('02-paste');
    assert.equal(paste.length, 4000);
    assert.ok(Math.abs(paste.height - paste.maxHeight) <= 1, 'paste reaches but does not exceed cap');
    assert.ok(paste.scrollTop > 0);

    await empty(client);
    const cleared = await capture('03-empty', false);
    assert.equal(cleared.length, 0);
    assert.ok(Math.abs(cleared.height - cleared.minHeight) <= 1, 'empty shrinks to CSS minimum');

    const transcript = 'Voice dictation should leave the newest spoken sentence visible above the controls. '.repeat(45);
    await worker.evaluate(`chrome.storage.local.set({hermesVoiceDraft: {transcript:${JSON.stringify(transcript)}, source:'QA transcript fixture', ts:Date.now()}})`);
    await waitFor(() => client.evaluate(`document.querySelector('#promptInput').value === ${JSON.stringify(transcript.trim())}`), 'external transcript consumed');
    const voice = await capture('04-external-dictation');
    assert.equal(voice.selection, voice.length, 'external dictation selects end');
    await waitFor(async () => !(await worker.evaluate(`(async () => (await chrome.storage.local.get('hermesVoiceDraft')).hermesVoiceDraft)()`)), 'draft storage cleared');

    // Capture the real lexical live-dictation entry point without a production test export.
    const source = await readFile(path.resolve(import.meta.dirname, '../extension/sidepanel.js'), 'utf8');
    const bodyLine = source.slice(0, source.indexOf('  const stats = estimateContextWindow({', source.indexOf('function renderContextWindow('))).split('\n').length - 1;
    await client.call('Debugger.enable');
    const { breakpointId } = await client.call('Debugger.setBreakpointByUrl', { urlRegex: '/sidepanel\\.js$', lineNumber: bodyLine });
    const eventStart = client.events.length;
    const insertion = client.call('Input.insertText', { text: 'x' });
    const paused = await waitFor(() => client.events.slice(eventStart).find(event => event.method === 'Debugger.paused'), 'module lexical scope');
    const captured = await client.call('Debugger.evaluateOnCallFrame', {
      callFrameId: paused.params.callFrames[0].callFrameId,
      expression: 'globalThis.__composerQaLiveDictation = applyDictationTranscript; true', returnByValue: true,
    });
    assert.ok(!captured.exceptionDetails);
    await client.call('Debugger.removeBreakpoint', { breakpointId });
    await client.call('Debugger.resume');
    await insertion;
    await client.call('Debugger.disable');
    await empty(client);
    await client.evaluate(`globalThis.__composerQaLiveDictation(${JSON.stringify(transcript)})`);
    const live = await capture('05-live-dictation');
    assert.equal(live.selection, live.length, 'live dictation selects end');
    assert.ok(live.scrollTop > 0);
    await client.evaluate('delete globalThis.__composerQaLiveDictation');

    await client.evaluate('document.querySelector("#promptInput").scrollTop = 0');
    await pause(350);
    assert.equal(await client.evaluate('document.querySelector("#promptInput").scrollTop'), 0, 'manual scrolling remains still');
    await capture('06-manual-scroll', false);
    await client.call('Input.insertText', { text: '!' });
    await capture('07-follow-after-edit');

    await client.evaluate(`document.documentElement.style.setProperty('--hermes-text-zoom', '1.75')`);
    await empty(client);
    for (let offset = 0; offset < text.length; offset += 60) {
      await client.call('Input.insertText', { text: text.slice(offset, offset + 60) });
      await settle(client);
      assertFrame(await metrics(client), `zoom-typing-${offset}`);
    }
    const zoom = await capture('08-zoom175');
    assert.ok(parseFloat(zoom.fontSize) >= parseFloat(typed.fontSize) * 1.7, 'real text zoom applied');
    await client.evaluate('document.documentElement.style.removeProperty("--hermes-text-zoom")');
    await empty(client);

    await client.call('Input.insertText', { text: 'A short draft can still be resized by hand.' });
    await settle(client);
    const resizeBefore = await client.evaluate(`(() => { const r = document.querySelector('#promptInput').getBoundingClientRect(); return { x:r.right-3, y:r.bottom-3, height:r.height }; })()`);
    await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resizeBefore.x, y: resizeBefore.y });
    await client.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: resizeBefore.x, y: resizeBefore.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 5; step++) {
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resizeBefore.x, y: resizeBefore.y + step * 14, button: 'left', buttons: 1 });
      await pause(30);
    }
    await client.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: resizeBefore.x, y: resizeBefore.y + 70, button: 'left', buttons: 0, clickCount: 1 });
    await pause(300);
    const manual = await capture('09-manual-resize');
    assert.equal(manual.resize, 'vertical');
    assert.ok(manual.height > resizeBefore.height + 20, 'native resize handle grows upwards with bottom-anchored composer');
    await pause(350);
    assert.equal(await client.evaluate('document.querySelector("#promptInput").getBoundingClientRect().height'), manual.height, 'idle render does not undo manual resize');
    await empty(client);
    assert.ok((await metrics(client)).height <= startHeight + 1, 'next text edit resets manual height');

    await client.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: false });
    await client.call('Input.insertText', { text: pasted });
    await capture('10-narrow');
    await client.evaluate('document.documentElement.dir = "rtl"');
    await empty(client);
    await client.call('Input.insertText', { text: 'مرحبا بالعالم هذا النص يبقى واضحا فوق الأزرار. '.repeat(50) });
    await capture('11-rtl');
  }
  await client.evaluate('document.documentElement.dir = "ltr"');
  await client.call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false });
  // Seed sessionStorage before the real panel's first render.
  const restored = await openPanel('sidepanel.html', `
    sessionStorage.setItem('hermesBrowserInstanceId', 'composer-restore-qa');
    sessionStorage.setItem('hermesBrowserComposerDraft:composer-restore-qa', ${JSON.stringify(JSON.stringify({ version: 1, text, attachments: [] }))});
  `);
  try {
    await waitFor(() => restored.client.evaluate(`document.querySelector('#startupScreen')?.hidden && document.querySelector('#promptInput')?.value.length === 600`), 'draft restored on cold start');
    await settle(restored.client);
    const data = await metrics(restored.client);
    report.checks.push({ name: '12-restored-draft', ...data });
    const filename = path.join(qaDir, '12-restored-draft.png');
    await saveScreenshot(restored.client, filename);
    report.screenshots.push(filename);
    assertFrame(data, 'restored-draft');
  } finally {
    restored.client.close();
    await client.call('Page.bringToFront');
  }
  await empty(client);
  await client.call('Input.insertText', { text });
  await client.evaluate(`document.documentElement.dataset.hermesMode = 'light'; document.documentElement.dataset.hermesColorMode = 'light'`);
  await capture('13-light');
  for (const position of [0, 1, 25, 63, 160, 360, 580]) {
    await client.evaluate(`document.querySelector('#promptInput').setSelectionRange(${position}, ${position})`);
    const data = await metrics(client);
    const mirror = await client.evaluate(`(async () => { const {measureCaretRect} = await import('./lib/composer-autogrow.mjs'); return measureCaretRect(document.querySelector('#promptInput')); })()`);
    const actualTop = data.nativeCaret.top - data.top - data.borderTop + data.scrollTop;
    assert.ok(Math.abs(mirror.top - actualTop) <= 2, `mirror at ${position}: ${mirror.top} vs native caret ${actualTop}`);
  }
  console.log('[composer-qa] PASS', JSON.stringify({ checks: report.checks.length, screenshots: report.screenshots.length }));
  return report;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createToolCallGroup, updateToolCallGroup, mergeToolCallActivity } from '../extension/lib/tool-call-group.mjs';
import { sessionIsLiveFromStatus } from '../extension/lib/live-session-attach.mjs';
import { resolveMessageResponseStyle, responsePresentationFromSettings } from '../extension/lib/response-presentation.mjs';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const updaterSource = source.slice(source.indexOf('function createStreamingMessageUpdater('), source.indexOf('// A gateway still running pre-update code'));

test('the actual gateway session.status text proves liveness', () => {
  assert.equal(sessionIsLiveFromStatus({ output: 'Hermes TUI Status\nAgent Running: Yes' }), true);
  assert.equal(sessionIsLiveFromStatus({ output: 'Hermes TUI Status\nAgent Running: No' }), false);
  assert.equal(sessionIsLiveFromStatus({ output: 'Other text says Yes' }), false);
});

test('a live updater restores accumulated text and tool activity after its DOM node is replaced', async () => {
  const { document } = parseHTML('<html><body><div class=message-row><article id=old></article></div><div class=message-row><article id=new></article></div></body></html>');
  const painted = new Map();
  const tools = new Map();
  const context = vm.createContext({resolveMessageResponseStyle,responsePresentationFromSettings,settings:{},
    document, createToolCallGroup, updateToolCallGroup, mergeToolCallActivity, translateUiText: value => value, t: (_key, {count}) => `${count} tools`,
    renderThinkingIndicator: element => { element.textContent = 'Thinking'; },
    THINKING_PLACEHOLDER: 'Thinking',
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setMessageContent: (node, text) => painted.set(node, text),
    setToolActivity: (node, activity) => tools.set(node, activity),
    activeImageGenerationPlaceholder: () => null,
    extractRenderableImageSource: () => '',
    panelMessageThread: null,
    setRailCopyEnabled: () => {},
  });
  const create = vm.runInContext(`${updaterSource}; createStreamingMessageUpdater`, context);
  const oldNode = document.getElementById('old');
  const newNode = document.getElementById('new');
  const view = create(oldNode);
  const activity = { rawName: 'terminal', status: 'progress' };
  view.updateText('First chunk while away');
  view.updateTool(activity);
  assert.equal(typeof view.rebind, 'function', 'navigation needs a rebindable updater, not a permanently detached bubble');
  view.rebind(newNode);
  assert.equal(painted.get(newNode), 'First chunk while away');
  assert.equal(tools.get(newNode), null, 'ordinary tool calls must not become an assistant bubble');
  assert.equal(document.querySelectorAll('.tool-call-group').length, 1);
  assert.match(document.querySelector('.tool-call-entry').textContent, /terminal/);
  assert.equal(view.node, newNode);
  await view.flush('Final answer');
  assert.equal(painted.get(newNode), 'Final answer');
  assert.equal(tools.get(newNode), null);
});

test('disposing a live updater paints text that was still waiting for its frame', () => {
  const { document } = parseHTML('<html><body><div class=message-row><article id=bubble></article></div></body></html>');
  const painted = [];
  const frames = new Map();
  let nextFrame = 0;
  const context = vm.createContext({resolveMessageResponseStyle,responsePresentationFromSettings,settings:{},
    document, createToolCallGroup, updateToolCallGroup, mergeToolCallActivity, translateUiText: value => value, t: (_key, {count}) => `${count} tools`,
    renderThinkingIndicator: () => {},
    THINKING_PLACEHOLDER: 'Hermes is thinking...',
    requestAnimationFrame: (callback) => { nextFrame += 1; frames.set(nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => { frames.delete(id); },
    setMessageContent: (_node, text) => painted.push(text),
    setToolActivity: () => {},
    activeImageGenerationPlaceholder: () => null,
    extractRenderableImageSource: () => '',
    panelMessageThread: null,
    setRailCopyEnabled: () => {},
  });
  const create = vm.runInContext(`${updaterSource}; createStreamingMessageUpdater`, context);
  const view = create(document.getElementById('bubble'));
  view.updateText('Streaming failed, retrying non-streaming...');
  assert.deepEqual(painted, [], 'the text is painted on the next frame');
  // The turn fails before that frame runs.
  view.dispose();
  assert.equal(painted.at(-1), 'Streaming failed, retrying non-streaming...', 'the notice must not be replaced by the thinking indicator');
  assert.equal(frames.size, 0, 'no frame is left to run after the turn ended');

  painted.length = 0;
  const idle = create(document.getElementById('bubble'));
  idle.dispose();
  assert.deepEqual(painted, [], 'disposing with nothing pending paints nothing');
});

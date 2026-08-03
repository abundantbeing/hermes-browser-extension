import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import {
  CONTEXT_MENU_CONFIG_STORAGE_KEY,
  applyContextMenuConfigMutation,
  cloneDefaultContextMenuConfig,
} from '../extension/lib/context-menu-config.mjs';
import {
  CONTEXT_MENU_CONFIG_GET,
  CONTEXT_MENU_CONFIG_MUTATE,
} from '../extension/lib/context-menu-controller.mjs';
import { mountContextMenuEditor } from '../extension/lib/context-menu-editor-client.mjs';

test('simultaneous side-panel and Hermes Web editors synchronize through the dedicated config record', async () => {
  const { document, Event } = parseHTML('<!doctype html><html><body><div id="panel"></div><div id="web"></div></body></html>');
  let config = cloneDefaultContextMenuConfig();
  const listeners = new Set();
  const messages = [];
  const chromeApi = {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (message.type === CONTEXT_MENU_CONFIG_GET) return { ok: true, config };
        if (message.type !== CONTEXT_MENU_CONFIG_MUTATE) return null;
        const oldValue = config;
        config = applyContextMenuConfigMutation(config, message.mutation);
        for (const listener of listeners) {
          listener({
            [CONTEXT_MENU_CONFIG_STORAGE_KEY]: { oldValue, newValue: config },
          }, 'local');
        }
        return { ok: true, config };
      },
    },
    storage: {
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); },
      },
    },
  };

  const panel = await mountContextMenuEditor({ chromeApi, root: document.getElementById('panel') });
  const web = await mountContextMenuEditor({ chromeApi, root: document.getElementById('web') });
  const title = document.querySelector('#panel [data-item-id="hermes-browser-ask-selection"] [data-field="title"]');
  title.value = 'Ask from either surface';
  title.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    document.querySelector('#web [data-item-id="hermes-browser-ask-selection"] [data-field="title"]').value,
    'Ask from either surface',
  );
  assert.equal(messages.filter((message) => message.type === CONTEXT_MENU_CONFIG_MUTATE).length, 1);
  assert.equal(messages.some((message) => Object.hasOwn(message, 'hermesBrowserSettings')), false);
  panel.destroy();
  web.destroy();
  assert.equal(listeners.size, 0);
});

test('editor client surfaces the background mutation reason instead of a generic save failure', async () => {
  const { document, Event } = parseHTML('<!doctype html><html><body><div id="editor"></div></body></html>');
  const chromeApi = {
    runtime: {
      async sendMessage(message) {
        if (message.type === CONTEXT_MENU_CONFIG_GET) {
          return { ok: true, config: cloneDefaultContextMenuConfig() };
        }
        if (message.type === CONTEXT_MENU_CONFIG_MUTATE) {
          return { ok: false, reason: 'Browser menu permission was revoked.' };
        }
        return null;
      },
    },
    storage: { onChanged: { addListener() {}, removeListener() {} } },
  };

  const editor = await mountContextMenuEditor({
    chromeApi,
    root: document.getElementById('editor'),
  });
  const title = document.querySelector('[data-item-id="hermes-browser-ask-selection"] [data-field="title"]');
  title.value = 'Rejected title';
  title.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const status = document.querySelector('.context-menu-editor-status.error');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Browser menu permission was revoked/);
  editor.destroy();
});

test('editor client tells the user to reload when an updated page reaches a stale background worker', async () => {
  const { document, Event } = parseHTML('<!doctype html><html><body><div id="editor"></div></body></html>');
  const chromeApi = {
    runtime: {
      async sendMessage(message) {
        if (message.type === CONTEXT_MENU_CONFIG_GET) {
          return { ok: true, config: cloneDefaultContextMenuConfig() };
        }
        if (message.type === CONTEXT_MENU_CONFIG_MUTATE) return undefined;
        return null;
      },
    },
    storage: { onChanged: { addListener() {}, removeListener() {} } },
  };

  const editor = await mountContextMenuEditor({
    chromeApi,
    root: document.getElementById('editor'),
  });
  const title = document.querySelector('[data-item-id="hermes-browser-ask-selection"] [data-field="title"]');
  title.value = 'Updated through a stale worker';
  title.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const status = document.querySelector('.context-menu-editor-status.error');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /Reload Hermes Browser.*chrome:\/\/extensions/i);
  editor.destroy();
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootAssist, focusField } from './inline-assist-dom.mjs';

test('no circle on a site hidden by its adapter id', async () => {
  const env = bootAssist({ url: 'https://x.com/home', storage: { hermesInlineAssistHiddenSites: ['x'] } });
  const launcher = await focusField(env);
  assert.equal(launcher.hidden, true);
});

test('no circle on a hidden hostname or its subdomains; other sites keep it', async () => {
  const hidden = bootAssist({ url: 'https://forum.page.example/new', storage: { hermesInlineAssistHiddenSites: ['page.example'] } });
  assert.equal((await focusField(hidden)).hidden, true);
  const shown = bootAssist({ url: 'https://other.example/new', storage: { hermesInlineAssistHiddenSites: ['page.example'] } });
  assert.equal((await focusField(shown)).hidden, false);
});

for (const [url, expected] of [['https://page.example/new', 'page.example'], ['https://www.x.com/home', 'x']]) {
  test(`"Hide the circle on this site" saves ${expected} and hides the circle`, async () => {
    const env = bootAssist({ url, settings: { inlineAssistOpenMode: 'quick' }, storage: { hermesInlineAssistHiddenSites: ['other.example'] } });
    const launcher = await focusField(env);
    env.userClick(launcher);
    await env.sleep(60);
    env.userClick(env.root().querySelector('.quick-options'));
    await env.sleep(40);
    const toggle = env.root().querySelector('input.toggle[data-setting="hide-site"]');
    assert.ok(toggle, 'the options view has the hide switch');
    toggle.checked = true;
    for (const listener of env.listenersFor(toggle, 'change')) listener.call(toggle, { type: 'change', target: toggle, isTrusted: true });
    await env.sleep(40);
    // Its own key: the page never rewrites the settings record Settings and Hermes Control also save.
    assert.equal(env.stored.some((items) => items.hermesBrowserSettings), false);
    const write = env.stored.findLast((items) => items.hermesInlineAssistHiddenSites);
    assert.deepEqual([...(write?.hermesInlineAssistHiddenSites || [])], ['other.example', expected]);
    assert.equal(env.root().querySelector('.launcher').hidden, true);
    assert.equal(env.root().querySelector('.panel').hidden, true);
  });
}

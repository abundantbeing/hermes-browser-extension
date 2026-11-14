import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { accountSignInLabelKey } from '../extension/lib/hermes-account.mjs';

// The sign-in button names where you sign in: a gateway whose only sign-in is Nous says Sign in with Nous Portal.

test('a gateway that signs in only through Nous labels the button Sign in with Nous Portal', () => {
  assert.equal(accountSignInLabelKey(['nous']), 'account.sign_in_nous');
  assert.equal(accountSignInLabelKey(['Nous']), 'account.sign_in_nous');
});

test('any other gateway keeps the general label', () => {
  for (const providers of [[], ['basic'], ['nous', 'basic'], null, undefined, ['self_hosted']]) {
    assert.equal(accountSignInLabelKey(providers), 'account.sign_in');
  }
});

test('every language has the Nous Portal label, with the brand name kept as it is', async () => {
  const dir = new URL('../extension/lib/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  assert.equal(files.length, 21);
  for (const file of files) {
    const table = (await import(new URL(file, dir))).default;
    assert.match(String(table['account.sign_in_nous'] || ''), /Nous Portal/, file);
  }
  const english = (await import(new URL('en.mjs', dir))).default;
  assert.equal(english['account.sign_in_nous'], 'Sign in with Nous Portal');
});

test('the Settings button and the Projects card both take the label from the gateway\'s providers', () => {
  const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  assert.match(source, /accountSignInLabelKey\(accountOffer\.providers\)/);
  const panel = readFileSync(new URL('../extension/lib/projects-panel.mjs', import.meta.url), 'utf8');
  assert.match(panel, /t\(controller\.accountSignInLabelKey\?\.\(\) \|\| 'account\.sign_in'\)/);
});

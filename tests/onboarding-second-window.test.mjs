// Setup in two windows, and setup run again: the second window follows the
// completed flag (and closes quietly), and a failed Connect's reason never
// outlives the run it belonged to.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const js = fs.readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');

function fn(name) {
  const asyncStart = js.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : js.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return js.slice(start, js.indexOf('\n}\n', start) + 3);
}

const KEY = 'hermesOnboardingCompleted';

function harness({ open = true, exiting = false, connected = false, failure = 'The gateway said no' } = {}) {
  const calls = [];
  const flow = {
    isOpen: open,
    isExiting: exiting,
    close() { calls.push('close'); this.isOpen = false; },
    open(args) { calls.push(['open', args]); },
    render() {},
  };
  const context = {
    ONBOARDING_COMPLETED_STORAGE_KEY: KEY,
    onboardingCompleted: false,
    onboardingConnectFailure: failure,
    onboardingFlow: flow,
    connectDeferred: false,
    connectDialogDismissed: false,
    isConnected: () => connected,
    setOnboardingOpen: (value) => calls.push(['setOnboardingOpen', value]),
    renderConnectDialog: () => calls.push('renderConnectDialog'),
    renderStartupReadiness: () => calls.push('renderStartupReadiness'),
    ensureOnboardingFlow: () => flow,
    backgroundArtRotation: { ensureOnboardingArt: () => Promise.resolve() },
    onboardingLanguage: null,
    explicitLocaleStored: false,
    getLocale: () => 'en',
    browserLanguageSuggestion: () => 'de',
    els: { startupScreen: null },
    hideFirstPrompt() {},
    setResponsePresentation: () => Promise.resolve(),
    responsePresentationFromSettings: () => ({}),
    settings: {},
    browserApi: { storage: { local: { set: (values) => { calls.push(['storage.set', values]); return Promise.resolve(); } } } },
    hbeBootEmit() {},
  };
  vm.createContext(context);
  vm.runInContext([fn('adoptOnboardingCompletedChange'), fn('openOnboarding'), fn('completeOnboarding')].join('\n'), context);
  return { context, calls, flow };
}

test('setup completed in another window closes this one quietly and writes nothing', () => {
  const { context, calls } = harness();
  vm.runInContext(`adoptOnboardingCompletedChange({ ${KEY}: { oldValue: undefined, newValue: true } })`, context);
  assert.equal(context.onboardingCompleted, true, 'the flag is followed');
  assert.deepEqual(calls, ['close', ['setOnboardingOpen', false], 'renderConnectDialog', 'renderStartupReadiness'], 'closed, nothing saved or reset');
  assert.equal(context.onboardingConnectFailure, '');
  assert.equal(context.connectDeferred, true, 'unpaired: the pop-up stays closed until asked for, as where setup ended');
  assert.equal(context.connectDialogDismissed, true);
  assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === 'storage.set'), 'no picks are reset or written');
});

test('a paired window does not defer or dismiss the connect pop-up', () => {
  const { context, calls } = harness({ connected: true });
  vm.runInContext(`adoptOnboardingCompletedChange({ ${KEY}: { newValue: true } })`, context);
  assert.deepEqual(calls, ['close', ['setOnboardingOpen', false], 'renderStartupReadiness']);
  assert.equal(context.connectDeferred, false);
});

test('the writer\'s own change event, a closed flow, a rerun and a cleared flag change nothing', () => {
  for (const options of [{ open: false }, { exiting: true, open: false }]) {
    const { context, calls } = harness(options);
    vm.runInContext(`adoptOnboardingCompletedChange({ ${KEY}: { newValue: true } })`, context);
    assert.equal(context.onboardingCompleted, true, 'the flag is still followed');
    assert.deepEqual(calls, [], `${JSON.stringify(options)}: nothing is closed again`);
  }
  const rerun = harness();
  vm.runInContext(`adoptOnboardingCompletedChange({ ${KEY}: { oldValue: true, newValue: true } })`, rerun.context);
  assert.deepEqual(rerun.calls, [], 'a rerun finishing elsewhere rewrites the same value: this rerun stays');
  assert.equal(rerun.context.onboardingConnectFailure, 'The gateway said no');
  const cleared = harness();
  vm.runInContext(`adoptOnboardingCompletedChange({ ${KEY}: { oldValue: true, newValue: undefined } })`, cleared.context);
  assert.deepEqual(cleared.calls, []);
  assert.equal(cleared.context.onboardingCompleted, false);
});

test('storage.onChanged hands the completed flag to that follower', () => {
  assert.match(js, /browserApi\.storage\.onChanged\.addListener\(\(changes, areaName\) => \{[\s\S]*?if \(Object\.hasOwn\(changes, ONBOARDING_COMPLETED_STORAGE_KEY\)\) adoptOnboardingCompletedChange\(changes\);/);
});

test('a failed Connect\'s reason is cleared when setup opens and when it is completed', async () => {
  const opened = harness({ open: false });
  vm.runInContext('openOnboarding({ rerun: true })', opened.context);
  assert.equal(opened.context.onboardingConnectFailure, '', 'a rerun starts without the old error and the emphasised Manual setup');
  assert.deepEqual(opened.calls.at(-1)[0], 'open');
  const done = harness({ open: false });
  await vm.runInContext("completeOnboarding('later')", done.context);
  assert.equal(done.context.onboardingConnectFailure, '', 'Connect later closes the run and its failure with it');
  assert.equal(done.context.onboardingCompleted, true);
});

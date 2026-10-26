import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import english from '../extension/lib/locales/en.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';
import { PROJECTS_UNAVAILABLE, gatewayAuthorityAvailability } from '../extension/lib/projects-client.mjs';
import { createProjectsController } from '../extension/lib/projects-controller.mjs';
import { renderProjectsPanel } from '../extension/lib/projects-panel.mjs';
import { describeProjectsFailure } from '../extension/lib/projects-view.mjs';

// Projects when a Hermes account sign-in is the one thing missing.

const t = (key, params) => {
  assert.ok(Object.hasOwn(english, key), `missing English string ${key}`);
  return formatMessage(english[key], params, 'en');
};

function setup({ blockedReason = 'account-sign-in', signInWithAccount } = {}) {
  const { document } = parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const container = document.getElementById('host');
  const prepared = [];
  const controller = createProjectsController({
    getConnection: () => ({
      token: 1,
      identityInput: { endpoint: 'https://hermes.example.com', principal: '', profile: 'work' },
      dashboardWs: false,
      request: null,
      getReadyPayload: () => null,
      blockedReason,
    }),
    prepareConnection: async () => { prepared.push('prepared'); },
    openSession: () => {},
    createSessionInFolder: async () => {},
    signInWithAccount,
    onChange: () => renderProjectsPanel({ container, controller, t, locale: 'en' }),
  });
  return { container, controller, prepared };
}

test('a gateway that asks for a Hermes account sign-in blocks Projects with that reason, before the REST-only one', () => {
  const gate = gatewayAuthorityAvailability({ dashboardWs: false, readyPayload: null, blockedReason: PROJECTS_UNAVAILABLE.accountSignIn });
  assert.equal(gate.available, false);
  assert.equal(gate.reason, 'account-sign-in');
  const failure = describeProjectsFailure({ reason: 'account-sign-in', unavailable: true });
  assert.equal(failure.key, 'projects.unavailable.account_sign_in');
  assert.match(t(failure.key), /Sign in with your Hermes account/);
});

test('the unavailable card offers Sign in with your Hermes account, and the click signs in then reads Projects again', async () => {
  const signedIn = [];
  const { container, controller, prepared } = setup({ signInWithAccount: async () => { signedIn.push('signed-in'); } });
  await controller.activate();
  const block = container.querySelector('[data-testid="projects-unavailable"]');
  assert.equal(block.getAttribute('data-reason'), 'account-sign-in');
  const button = container.querySelector('[data-testid="projects-account-sign-in"]');
  assert.ok(button, 'the card offers the sign-in');
  assert.equal(button.textContent, english['account.sign_in']);
  const before = prepared.length;
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(signedIn, ['signed-in']);
  assert.ok(prepared.length > before, 'Projects was read again after signing in');
});

test('a failed sign-in still reads Projects again, and the button is not offered for other reasons or without a handler', async () => {
  const failing = setup({ signInWithAccount: async () => { throw new Error('closed the window'); } });
  await failing.controller.activate();
  const before = failing.prepared.length;
  await assert.rejects(() => failing.controller.accountSignIn(), /closed the window/);
  assert.ok(failing.prepared.length > before);

  const withoutHandler = setup({});
  await withoutHandler.controller.activate();
  assert.equal(withoutHandler.container.querySelector('[data-testid="projects-account-sign-in"]'), null);
  assert.equal(withoutHandler.controller.canAccountSignIn(), false);

  const other = setup({ blockedReason: 'webapp-sign-in', signInWithAccount: async () => {} });
  await other.controller.activate();
  assert.equal(other.container.querySelector('[data-testid="projects-account-sign-in"]'), null, 'only the account reason offers it');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import english from '../extension/lib/locales/en.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';
import { PROJECTS_UNAVAILABLE, gatewayAuthorityAvailability } from '../extension/lib/projects-client.mjs';
import { createProjectsController } from '../extension/lib/projects-controller.mjs';
import { renderProjectsPanel } from '../extension/lib/projects-panel.mjs';
import { describeProjectsFailure } from '../extension/lib/projects-view.mjs';

// Projects when Hermes Web's sign-in is the one thing missing.

const t = (key, params) => {
  assert.ok(Object.hasOwn(english, key), `missing English string ${key}`);
  return formatMessage(english[key], params, 'en');
};
const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };

function projectsSetup(connection) {
  const { document } = parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const container = document.getElementById('host');
  const prepared = [];
  const controller = createProjectsController({
    getConnection: () => ({
      token: 1,
      identityInput: { endpoint: 'http://127.0.0.1:9120', principal: '', profile: 'work' },
      dashboardWs: false,
      request: null,
      getReadyPayload: () => null,
      ...connection,
    }),
    prepareConnection: async () => { prepared.push('prepared'); },
    openSession: () => {},
    createSessionInFolder: async () => {},
    onChange: () => renderProjectsPanel({ container, controller, t, locale: 'en' }),
  });
  return { container, controller, prepared };
}

test('a connection blocked by Hermes Web\'s sign-in says exactly that, before any other reason', () => {
  assert.deepEqual(
    gatewayAuthorityAvailability({ dashboardWs: false, readyPayload: null, blockedReason: PROJECTS_UNAVAILABLE.webappSignIn }),
    { available: false, reason: 'webapp-sign-in', message: "Projects needs Hermes Web's sign-in. Open Hermes Web once (run hermes webapp), then try again." },
  );
  // No blocked reason: exactly what it was.
  assert.equal(gatewayAuthorityAvailability({ dashboardWs: false, readyPayload: null }).reason, 'rest-only');
  assert.equal(gatewayAuthorityAvailability({ dashboardWs: false, readyPayload: null, blockedReason: '' }).reason, 'rest-only');
  assert.equal(gatewayAuthorityAvailability({ dashboardWs: true, readyPayload: READY, blockedReason: '' }).available, true);
});

test('the failure for that reason has its own string, an unavailable one that leaves Recents promised', () => {
  const failure = describeProjectsFailure({ reason: 'webapp-sign-in', unavailable: true });
  assert.equal(failure.key, 'projects.unavailable.webapp_sign_in');
  assert.equal(failure.unavailable, true);
  assert.match(t(failure.key), /Hermes Web's sign-in/);
  assert.match(t(failure.key), /hermes webapp/);
});

test('the drawer shows the sign-in reason instead of the misleading ones, and no raw connect error', async () => {
  const { container, controller } = projectsSetup({ blockedReason: 'webapp-sign-in', connectError: 'Your Hermes dashboard tab is not signed in.' });
  await controller.activate();
  const block = container.querySelector('[data-testid="projects-unavailable"]');
  assert.ok(block);
  assert.equal(block.getAttribute('data-reason'), 'webapp-sign-in');
  const text = container.textContent.replace(/\s+/g, ' ');
  assert.match(text, /Projects needs Hermes Web's sign-in\. Open Hermes Web once \(run hermes webapp\), then try again\./);
  assert.doesNotMatch(text, /dashboard tab is not signed in/i);
  assert.doesNotMatch(text, /only reaches the REST API/);
  assert.match(text, /Recents still works/);
});

test('Try again in the drawer asks the panel to prepare the connection again, which retries the capture', async () => {
  const { container, controller, prepared } = projectsSetup({ blockedReason: 'webapp-sign-in' });
  await controller.activate();
  const before = prepared.length;
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Try again'));
  assert.ok(retry, 'the drawer offers the retry');
  retry.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(prepared.length > before, 'refreshing runs prepareConnection again');
});

test('without a blocked reason the drawer is unchanged: rest-only still says so', async () => {
  const { container, controller } = projectsSetup({});
  await controller.activate();
  assert.equal(container.querySelector('[data-testid="projects-unavailable"]').getAttribute('data-reason'), 'rest-only');
});

// Saving a new project's idea: the session opens in the project folder and the message that writes IDEA.md waits
// in the composer for the person to send; nothing is sent for them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const lines = source.split('\n');
function functionSource(name) {
  const start = lines.findIndex((line) => new RegExp(`^(async )?function ${name}[(]`).test(line));
  assert.ok(start >= 0, `${name} exists`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  return lines.slice(start, end + 1).join('\n');
}

function harness() {
  const toasts = [];
  const events = [];
  const input = {
    value: '',
    dispatchEvent(event) { events.push(event.type); },
    focus() { events.push('focus'); },
  };
  const context = vm.createContext({
    activeConversationTransport: 'dashboard-ws',
    activeDashboardWsConnection: {},
    settings: { sessionId: 'S-old' },
    sessionLoadRequestId: 0,
    Event: class { constructor(type) { this.type = type; } },
    persistBrowserIntroSeen: async () => {},
    detachLiveSession() {},
    createHermesBrowserSession: async () => ({ id: 'S-new' }),
    refreshLiveSessionRoster: async () => {},
    t: (key, params = {}) => `${key}${params.idea ? `|${params.idea}` : ''}${params.name ? `|${params.name}` : ''}`,
    els: { input, sessionMenu: { hidden: false }, sessionMenuButton: { setAttribute() {} } },
    showOperationToast: (toast) => toasts.push(toast),
    loadSessions: async () => {},
  });
  vm.runInContext(functionSource('createSessionInProjectFolder'), context);
  return { context, input, toasts, events };
}

test('an idea leaves the IDEA.md message in the composer, unsent, and says so', async () => {
  const h = harness();
  await h.context.createSessionInProjectFolder({ cwd: '/srv/new', projectName: 'New', idea: '  A tiny idea.  ' });
  assert.equal(h.input.value, 'projects.idea.prompt|A tiny idea.');
  assert.deepEqual(h.events, ['input', 'focus'], 'the composer resizes and takes focus');
  assert.equal(h.toasts[0].title, 'projects.idea.started|New');
  assert.equal(h.toasts[0].detail, '/srv/new');
});

test('without an idea the composer is left alone and the usual toast shows', async () => {
  const h = harness();
  h.input.value = 'a draft';
  await h.context.createSessionInProjectFolder({ cwd: '/srv/new', projectName: 'New' });
  assert.equal(h.input.value, 'a draft');
  assert.equal(h.toasts[0].title, 'projects.new_session.started|New');
});

test('the Projects connection hands the folder picker the session this panel is viewing', () => {
  const snapshot = functionSource('projectsConnectionSnapshot');
  assert.match(snapshot, /getSessionId: \(\) => connection\?\.wsSessionId \|\| settings\.sessionId \|\| ''/);
});

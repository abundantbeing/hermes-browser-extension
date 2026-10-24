import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import english from '../extension/lib/locales/en.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';
import { createProjectsController } from '../extension/lib/projects-controller.mjs';
import { renderProjectsPanel } from '../extension/lib/projects-panel.mjs';

const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };
const t = (key, params) => {
  assert.ok(Object.hasOwn(english, key), `missing English string ${key}`);
  return formatMessage(english[key], params, 'en');
};

const folder = (path) => ({ path, label: null, is_primary: true, added_at: 1 });
const project = (id, name, path) => ({
  id, slug: name.toLowerCase(), name, description: null, icon: null, color: null, board_slug: null,
  primary_path: path, archived: false, created_at: 1, folders: [folder(path)],
});
const node = (id, label, path, extra = {}) => ({
  id, label, path, color: null, icon: null, isAuto: false, isNoProject: false, sessionCount: 2, lastActive: 1790000000,
  totalTokens: 0, totalCostUsd: 0, repos: [], previewSessions: [], sessionIds: [], ...extra,
});
const session = (id, title) => ({
  id, title, preview: null, source: 'browser', model: 'm', started_at: 1, last_active: 1790000000, message_count: 2,
  is_active: false, cwd: '/srv/atlas', git_branch: 'main', git_repo_root: '/srv/atlas', profile: 'work',
});

function setup({ dashboardWs = true, ready = READY, request } = {}) {
  const { document } = parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const container = document.getElementById('host');
  const gateway = request || (async (method, params) => {
    if (method === 'projects.list') {
      return { projects: [project('p1', 'Atlas', '/srv/atlas'), project('p2', 'Atlas', '/srv/clients/atlas')], active_id: null };
    }
    if (method === 'projects.tree') {
      return { projects: [node('p1', 'Atlas', '/srv/atlas'), node('p2', 'Atlas', '/srv/clients/atlas', { sessionCount: 1 })], active_id: null, scoped_session_ids: [] };
    }
    if (method === 'projects.project_sessions') {
      return { project: node(params.project_id, 'Atlas', '/srv/atlas', { previewSessions: [session('s1', 'Fix the login redirect'), session('s2', 'x'.repeat(200))] }) };
    }
    throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
  });
  const opened = [];
  const controller = createProjectsController({
    getConnection: () => ({
      token: 1,
      identityInput: { endpoint: 'https://hermes.example.com', principal: 'u', profile: 'work' },
      dashboardWs,
      request: gateway,
      getReadyPayload: () => ready,
    }),
    openSession: (row) => opened.push(row),
    createSessionInFolder: async () => {},
    onChange: () => renderProjectsPanel({ container, controller, t, locale: 'en' }),
  });
  return { document, container, controller, opened };
}

const text = (container) => container.textContent.replace(/\s+/g, ' ');

test('the list shows the connected profile and host, folders, counts and tells two Atlas rows apart', async () => {
  const { container, controller } = setup();
  await controller.activate();
  assert.match(text(container), /Profile work on hermes\.example\.com/);
  assert.doesNotMatch(text(container), /\b(null|undefined)\b/, 'no stray empty pieces render as text');
  const rows = [...container.querySelectorAll('.projects-row')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /2 sessions/);
  assert.match(rows[1].textContent, /1 session\b/);
  assert.ok(rows.every((row) => row.querySelector('.projects-disambiguator')), 'duplicate names carry their folder');
  assert.match(rows[1].querySelector('button').getAttribute('aria-label'), /\/srv\/clients\/atlas/);
});

test('the list is searchable and says when nothing matches', async () => {
  const { container, controller } = setup();
  await controller.activate();
  controller.setQuery('clients');
  assert.equal(container.querySelectorAll('.projects-row').length, 1);
  controller.setQuery('zzz');
  assert.equal(container.querySelectorAll('.projects-row').length, 0);
  assert.ok(container.querySelector('[data-testid="projects-no-match"]'));
});

test('an empty profile offers to create the first project', async () => {
  const { container, controller } = setup({
    request: async (method) => (method === 'projects.list'
      ? { projects: [], active_id: null }
      : { projects: [], active_id: null, scoped_session_ids: [] }),
  });
  await controller.activate();
  const empty = container.querySelector('[data-testid="projects-empty"]');
  assert.ok(empty);
  assert.match(empty.textContent, /No projects yet/);
  assert.match(empty.textContent, /machine running Hermes/);
});

test('REST-only shows the exact reason code, keeps Recents promised, and is not blank', async () => {
  const { container, controller } = setup({ dashboardWs: false, ready: null });
  await controller.activate();
  const block = container.querySelector('[data-testid="projects-unavailable"]');
  assert.ok(block);
  assert.equal(block.getAttribute('data-reason'), 'rest-only');
  assert.match(block.textContent, /dashboard WebSocket/);
  assert.match(block.textContent, /Reason: rest-only/);
  assert.match(block.textContent, /Recents still works/);
  assert.equal(container.querySelectorAll('.projects-row').length, 0);
});

test('other unavailable reasons each render their own text', async () => {
  const legacy = setup({ ready: { replay_epoch: 'ep1' } });
  await legacy.controller.activate();
  assert.match(text(legacy.container), /did not advertise session authority/);
  assert.match(text(legacy.container), /Reason: no-session-authority/);
  const waiting = setup({ ready: null });
  await waiting.controller.activate();
  assert.match(text(waiting.container), /Reason: not-connected/);
  const missing = setup({ request: async () => { throw Object.assign(new Error('nope'), { rpcCode: -32601 }); } });
  await missing.controller.activate();
  assert.match(text(missing.container), /"method not found" \(-32601\) for projects\./);
  assert.match(text(missing.container), /Reason: method-not-found/);
});

test('a project opens to its sessions with search, long titles clipped by CSS not data, and a Move action per row', async () => {
  const { container, controller, opened } = setup();
  await controller.activate();
  await controller.openProject('p1');
  assert.match(text(container), /Fix the login redirect/);
  assert.ok(container.querySelector('.projects-primary-action'), 'New session in this project');
  const rows = container.querySelectorAll('.projects-session-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].querySelector('.session-option-name').getAttribute('title').length, 200, 'the full title stays available');
  controller.setQuery('login');
  assert.equal(container.querySelectorAll('.projects-session-row').length, 1);
  controller.setQuery('nothing here');
  assert.ok(container.querySelector('[data-testid="projects-sessions-empty"]'));
  controller.setQuery('');
  container.querySelector('.projects-session-row button.session-option').dispatchEvent(new container.ownerDocument.defaultView.Event('click'));
  assert.equal(opened[0].id, 's1');
  const move = container.querySelector('.projects-session-row .session-action-button');
  assert.match(move.getAttribute('aria-label'), /^Move Fix the login redirect to a project$/);
});

test('create form labels the gateway host, names every field, and shows the duplicate-name suggestion', async () => {
  const { container, controller } = setup();
  await controller.activate();
  controller.startCreate();
  const labels = [...container.querySelectorAll('label')].map((label) => label.getAttribute('for'));
  for (const id of labels) assert.ok(container.querySelector(`#${id}`), `label for ${id} has a control`);
  assert.match(text(container), /machine running Hermes \(hermes\.example\.com\)/);
  assert.match(text(container), /browser cannot open that machine's folder picker/);
  const path = container.querySelector('#projectsCreatePath');
  assert.equal(path.getAttribute('aria-describedby'), 'projectsCreatePathHint');
  controller.updateCreate('name', 'Atlas');
  const warning = container.querySelector('[data-testid="projects-duplicate-name"]');
  assert.ok(warning);
  assert.match(warning.textContent, /Use "Atlas \(2\)"/);
  await controller.submitCreate();
  const error = container.querySelector('#projectsCreatePathError');
  assert.ok(error, 'a missing folder is announced');
  assert.equal(container.querySelector('#projectsCreatePath').getAttribute('aria-invalid'), 'true');
});

test('creating a project renders every intermediate state without throwing and ends in the new project', async () => {
  const created = [];
  const { container, controller } = setup({
    request: async (method, params) => {
      if (method === 'projects.list') return { projects: [project('p1', 'Atlas', '/srv/atlas'), ...created], active_id: null };
      if (method === 'projects.tree') return { projects: [node('p1', 'Atlas', '/srv/atlas'), ...created.map((p) => node(p.id, p.name, p.primary_path))], active_id: null, scoped_session_ids: [] };
      if (method === 'projects.project_sessions') return { project: node(params.project_id, 'Gamma', '/srv/gamma') };
      if (method === 'projects.create') {
        const made = project('p9', params.name, params.primary_path);
        created.push(made);
        return { project: made };
      }
      throw new Error(`unexpected ${method}`);
    },
  });
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Gamma');
  controller.updateCreate('path', '/srv/gamma');
  const submit = controller.submitCreate();
  assert.match(text(container), /Creating…/);
  await submit;
  assert.equal(container.dataset.view, 'project');
  assert.match(container.querySelector('.projects-heading').textContent, /Gamma/);
  assert.match(text(container), /Created project Gamma/);
});

test('the move view states what a move does, lists destinations as radios, and gates on availability', async () => {
  const { container, controller } = setup();
  await controller.activate();
  await controller.startMove({ id: 's1', title: 'Fix login', cwd: '/srv/atlas/src' });
  assert.match(container.querySelector('[data-testid="projects-move-explainer"]').textContent, /changes its workspace and may change the folder its commands run in/);
  const radios = [...container.querySelectorAll('input[type="radio"]')];
  assert.deepEqual(radios.map((radio) => radio.value), ['p1', 'p2', 'custom']);
  assert.match(container.querySelector('.projects-choice.is-current').textContent, /current/);
  assert.equal(container.querySelector('[data-fk="move-submit"]').hasAttribute('disabled'), true, 'no destination yet');

  const rest = setup({ dashboardWs: false, ready: null });
  await rest.controller.startMove({ id: 's1', title: 'x', cwd: '' });
  assert.ok(rest.container.querySelector('[data-testid="projects-unavailable"]'));
  assert.equal(rest.container.querySelectorAll('input[type="radio"]').length, 0);
});

test('a live turn is confirmed explicitly in an alert dialog before anything is sent', async () => {
  const sent = [];
  const { container, controller } = setup({
    request: async (method, params) => {
      sent.push(method);
      if (method === 'projects.list') return { projects: [project('p1', 'Atlas', '/srv/atlas')], active_id: null };
      if (method === 'projects.tree') return { projects: [node('p1', 'Atlas', '/srv/atlas')], active_id: null, scoped_session_ids: [] };
      if (method === 'session.resume') {
        return { session_id: 's1', revision: 3, execution_generation: 1, execution_state: 'running', running: true, info: { cwd: '/srv/scratch', profile_name: 'work' } };
      }
      throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
    },
  });
  await controller.activate();
  await controller.startMove({ id: 's1', title: 'Busy one', cwd: '/srv/scratch' });
  controller.chooseMoveTarget('p1');
  await controller.confirmMove();
  const dialog = container.querySelector('[data-testid="projects-live-confirm"]');
  assert.ok(dialog);
  assert.equal(dialog.getAttribute('role'), 'alertdialog');
  assert.match(dialog.textContent, /A turn is running in this session/);
  assert.match(dialog.textContent, /Nothing has been changed yet/);
  assert.equal(sent.includes('session.mutate'), false);
});

test('an unchanged state does not rebuild the DOM, and an input method mid-composition is never interrupted', async () => {
  const { container, controller } = setup();
  await controller.activate();
  const first = container.querySelector('.projects-row');
  renderProjectsPanel({ container, controller, t, locale: 'en' });
  assert.equal(container.querySelector('.projects-row'), first, 'a repaint with the same state keeps the same nodes');

  controller.startCreate();
  const name = container.querySelector('#projectsCreateName');
  const view = container.ownerDocument.defaultView;
  name.dispatchEvent(new view.Event('compositionstart', { bubbles: true }));
  assert.equal(container.getAttribute('data-composing'), '1');
  controller.updateCreate('name', 'ア');
  assert.equal(container.querySelector('#projectsCreateName'), name, 'typing mid-composition leaves the field in place');
  name.value = 'アトラス';
  name.dispatchEvent(new view.Event('compositionend', { bubbles: true }));
  assert.equal(container.getAttribute('data-composing'), null);
  assert.equal(controller.state.create.name, 'アトラス');
  assert.equal(container.querySelector('#projectsCreateName').value, 'アトラス', 'the composed text is what the repainted field shows');
});

// The create form, the folder picker and the saved-idea prompt as the panel draws them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

import english from '../extension/lib/locales/en.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';
import { createProjectsController } from '../extension/lib/projects-controller.mjs';
import { renderProjectsPanel } from '../extension/lib/projects-panel.mjs';

const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };
const TOKEN = { id: 1 };
const t = (key, params) => {
  assert.ok(Object.hasOwn(english, key), `missing English string ${key}`);
  return formatMessage(english[key], params, 'en');
};

const project = (id, name, path) => ({
  id, slug: name.toLowerCase(), name, description: null, icon: null, color: null, board_slug: null,
  primary_path: path, archived: false, created_at: 1, folders: [{ path, label: null, is_primary: true, added_at: 1 }],
});
const node = (id, label, path) => ({
  id, label, path, color: null, icon: null, isAuto: false, isNoProject: false, sessionCount: 0, lastActive: 0,
  totalTokens: 0, totalCostUsd: 0, repos: [], previewSessions: [], sessionIds: [],
});

const DIRS = { '/home/ana': ['code', 'docs', 'music'], '/home/ana/code': ['api', 'web'] };

function setup({ listFolders = true, saved = [] } = {}) {
  const { document } = parseHTML('<!doctype html><html><body><div id="host"></div></body></html>');
  const container = document.getElementById('host');
  const created = [];
  const gateway = async (method, params) => {
    switch (method) {
      case 'projects.list': return { projects: [project('p1', 'Atlas', '/srv/atlas'), ...created], active_id: null };
      case 'projects.tree': return { projects: [node('p1', 'Atlas', '/srv/atlas'), ...created.map((p) => node(p.id, p.name, p.primary_path))], active_id: null, scoped_session_ids: [] };
      case 'projects.project_sessions': return { project: node(params.project_id, 'x', '/srv/x') };
      case 'projects.create': {
        const made = project('p9', params.name, params.primary_path);
        created.push(made);
        return { project: made };
      }
      case 'projects.for_cwd': return { project: null, cwd: params.cwd === '~' ? '/home/ana' : '/home/ana', branch: '' };
      case 'projects.discover_repos': return { repos: [{ root: '/srv/atlas', label: 'Atlas', sessions: 1, last_active: 1 }] };
      case 'complete.path': {
        if (!listFolders) throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
        const match = /^@folder:(.*)\/([^/]*)$/.exec(params.word);
        const names = DIRS[match[1] || '/'] || [];
        return { items: names.map((name) => ({ text: name, display: `${name}/`, meta: 'dir' })) };
      }
      case 'llm.oneshot': return { text: 'A tiny idea.' };
      default: throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
    }
  };
  const controller = createProjectsController({
    getConnection: () => ({
      token: TOKEN,
      identityInput: { endpoint: 'https://hermes.example.com', principal: 'u', profile: 'work' },
      dashboardWs: true,
      request: gateway,
      getReadyPayload: () => READY,
      getSessionId: () => 'S1',
    }),
    openSession: () => {},
    createSessionInFolder: async (args) => { saved.push(args); },
    onChange: () => renderProjectsPanel({ container, controller, t, locale: 'en' }),
  });
  return { container, controller, saved };
}

const text = (container) => container.textContent.replace(/\s+/g, ' ');
const byTest = (container, id) => container.querySelector(`[data-testid="${id}"]`);

test('the create form has Name, Folders with Add folder, an idea and Generate idea, like Desktop', async () => {
  const { container, controller } = setup();
  await controller.activate();
  controller.startCreate();
  const labels = [...container.querySelectorAll('label, .projects-label')].map((node) => node.textContent);
  for (const expected of ['Project name', 'Folders', 'Idea (IDEA.md)', 'Folder on the gateway host']) assert.ok(labels.includes(expected), expected);
  assert.equal(byTest(container, 'projects-add-folder').textContent, 'Add folder');
  assert.equal(byTest(container, 'projects-generate-idea').textContent, 'Generate idea');
  assert.ok(byTest(container, 'projects-create-no-folders'));
  controller.addCreateFolder('/home/ana/code/api');
  controller.addCreateFolder('/home/ana/code/web');
  const items = [...container.querySelectorAll('.projects-folder-item')];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /primary/);
  assert.doesNotMatch(items[1].textContent, /primary/);
  assert.equal(container.querySelector('#projectsCreateName').value, 'api');
  items[1].querySelector('button').dispatchEvent(new container.ownerDocument.defaultView.Event('click'));
  assert.equal(container.querySelectorAll('.projects-folder-item').length, 1);
});

test('Generate idea shows its busy label, then the generated text', async () => {
  const { container, controller } = setup();
  await controller.activate();
  controller.startCreate();
  const pending = controller.generateIdea();
  assert.equal(byTest(container, 'projects-generate-idea').textContent, 'Generating…');
  assert.equal(byTest(container, 'projects-generate-idea').hasAttribute('disabled'), true);
  await pending;
  assert.equal(container.querySelector('#projectsCreateIdea').value, 'A tiny idea.');
});

test('Add folder opens the picker: roots, breadcrumbs, folders only, Choose', async () => {
  const { container, controller } = setup();
  await controller.activate();
  controller.startCreate();
  await controller.openFolderPicker('create');
  assert.equal(container.dataset.view, 'picker');
  assert.match(container.querySelector('.projects-heading').textContent, /Choose a folder/);
  assert.deepEqual([...container.querySelectorAll('.projects-picker-root')].map((node) => node.textContent), ['Home', 'Atlas']);
  assert.deepEqual([...container.querySelectorAll('.projects-crumb')].map((node) => node.textContent), ['/', 'home', 'ana']);
  assert.equal(container.querySelector('.projects-crumb[aria-current="location"]').textContent, 'ana');
  const rows = [...container.querySelectorAll('.projects-picker-row')].map((node) => node.textContent.replace(/[▸↑]/g, '').trim());
  assert.deepEqual(rows, ['Up one level', 'code', 'docs', 'music']);
  assert.match(text(container), /Folders on the machine running Hermes \(hermes\.example\.com\), not on this computer/);
  assert.equal(byTest(container, 'projects-picker-choose').hasAttribute('disabled'), false);
  assert.match(text(container), /Folder: \/home\/ana/);
});

test('the filter hides folders that do not match, and an empty result says so', async () => {
  const { container, controller } = setup();
  await controller.activate();
  controller.startCreate();
  await controller.openFolderPicker('create');
  await controller.pickerFilter('mu');
  assert.deepEqual([...container.querySelectorAll('.projects-picker-name')].map((node) => node.textContent), ['music']);
  await controller.pickerFilter('zzz');
  assert.equal(container.querySelectorAll('.projects-picker-name').length, 0);
  assert.ok(byTest(container, 'projects-picker-empty'));
});

test('a host that cannot list says so, keeps the roots and the typed path, and lets the typed path be chosen', async () => {
  const { container, controller } = setup({ listFolders: false });
  await controller.activate();
  controller.startCreate();
  await controller.openFolderPicker('create');
  assert.match(byTest(container, 'projects-picker-failure').textContent, /cannot list its folders right now/);
  assert.ok(container.querySelector('#projectsPickerPath'), 'the typed fallback is there');
  assert.equal(container.querySelectorAll('.projects-picker-row').length, 0);
  controller.pickerSetTyped('/srv/typed');
  assert.equal(byTest(container, 'projects-picker-choose').hasAttribute('disabled'), false);
  controller.pickerChoose();
  assert.equal(container.dataset.view, 'create');
  assert.match(container.querySelector('.projects-folder-item').textContent, /\/srv\/typed/);
});

test('Move: Another folder offers Browse folders and opens the same picker', async () => {
  const { container, controller } = setup();
  await controller.activate();
  await controller.startMove({ id: 's1', title: 'Fix', cwd: '/srv/atlas' });
  const custom = container.querySelector('#projectsMove-custom');
  assert.ok(custom);
  controller.chooseMoveTarget('custom');
  const browse = byTest(container, 'projects-move-browse');
  assert.equal(browse.textContent, 'Browse folders…');
  assert.ok(container.querySelector('#projectsMovePath'), 'typing a path still works');
  await controller.openFolderPicker('move');
  assert.equal(container.dataset.view, 'picker');
  controller.pickerChoose();
  assert.equal(container.dataset.view, 'move');
  assert.equal(container.querySelector('#projectsMovePath').value, '/srv/atlas');
});

test('a created project with an idea offers to save it as IDEA.md, and saving hands the idea to the session opener', async () => {
  const saved = [];
  const { container, controller } = setup({ saved });
  await controller.activate();
  controller.startCreate();
  controller.updateCreate('name', 'Gamma');
  controller.addCreateFolder('/srv/gamma');
  controller.updateCreate('idea', 'Ship it.');
  await controller.submitCreate();
  const block = byTest(container, 'projects-pending-idea');
  assert.ok(block, 'shown on the new project');
  assert.match(block.textContent, /Your idea is not saved yet/);
  assert.match(text(container), /Created project Gamma\. Your idea is ready to save as IDEA\.md\./);
  block.querySelector('[data-fk="save-idea"]').dispatchEvent(new container.ownerDocument.defaultView.Event('click'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(saved, [{ cwd: '/srv/gamma', projectName: 'Gamma', idea: 'Ship it.' }]);
  assert.equal(byTest(container, 'projects-pending-idea'), null);
});

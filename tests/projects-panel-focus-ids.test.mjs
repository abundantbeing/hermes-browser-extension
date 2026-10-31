// Review finding 6 on the Projects panel: restoring focus after a rebuild cannot throw for any project id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import english from '../extension/lib/locales/en.mjs';
import { formatMessage } from '../extension/lib/i18n.mjs';
import { createProjectsController } from '../extension/lib/projects-controller.mjs';
import { renderProjectsPanel } from '../extension/lib/projects-panel.mjs';

const READY = { replay_epoch: 'ep1', change_events: true, heartbeat: true, session_authority: true };
const t = (key, params) => formatMessage(english[key] ?? key, params, 'en');
const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

const folder = (path) => ({ path, label: null, is_primary: true, added_at: 1 });
const project = (id, name, path) => ({
  id, slug: name.toLowerCase(), name, description: null, icon: null, color: null, board_slug: null,
  primary_path: path, archived: false, created_at: 1, folders: [folder(path)],
});
const node = (id, label, path, extra = {}) => ({
  id, label, path, color: null, icon: null, isAuto: false, isNoProject: false, sessionCount: 1, lastActive: 1790000000,
  totalTokens: 0, totalCostUsd: 0, repos: [], previewSessions: [], sessionIds: [], ...extra,
});

function setup({ rows, request }) {
  const { document } = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>').window;
  const container = document.getElementById('host');
  const gateway = request || (async (method) => {
    if (method === 'projects.list') return { projects: rows.map((row) => project(row.id, row.name, row.path)), active_id: null };
    if (method === 'projects.tree') {
      return { projects: rows.map((row) => node(row.id, row.name, row.path)), active_id: null, scoped_session_ids: [] };
    }
    throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
  });
  let controller;
  controller = createProjectsController({
    getConnection: () => ({
      token: 1,
      identityInput: { endpoint: 'https://hermes.example.com', principal: 'u', profile: 'work' },
      dashboardWs: true,
      request: gateway,
      getReadyPayload: () => READY,
    }),
    openSession: () => {},
    createSessionInFolder: async () => {},
    onChange: () => renderProjectsPanel({ container, controller, t, locale: 'en' }),
  });
  return { document, container, controller };
}

const BS = String.fromCharCode(92);
for (const id of ['o"brien', ['C:', 'Users', 'me', 'repo', ''].join(BS), 'plain-id', 'auto:/srv/with]bracket', "it's"]) {
  test(`a re-render keeps focus on a project row whose id is ${JSON.stringify(id)}`, async () => {
    const rows = [{ id, name: 'Odd', path: '/srv/odd' }, { id: 'p2', name: 'Other', path: '/srv/other' }];
    const { container, controller, document } = setup({ rows });
    await controller.activate();
    const target = [...container.querySelectorAll('[data-fk]')].find((node) => node.getAttribute('data-fk') === `project:${id}`);
    assert.ok(target, 'the row is rendered with its focus key');
    target.focus();
    assert.equal(document.activeElement, target);
    // A roster tick re-renders with new state: nothing may throw, and focus stays on the row.
    controller.setQuery('o');
    controller.setQuery('');
    renderProjectsPanel({ container, controller, t, locale: 'en' });
    const after = [...container.querySelectorAll('[data-fk]')].find((node) => node.getAttribute('data-fk') === `project:${id}`);
    assert.ok(after);
    assert.equal(document.activeElement, after, 'focus was put back on the same row');
  });
}

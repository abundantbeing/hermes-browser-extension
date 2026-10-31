// Review finding 2 on the Projects panel: Back is off while a move is committing.
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

test('the Back button is disabled while a move is committing', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const rows = [{ id: 'p1', name: 'Atlas', path: '/srv/atlas' }];
  const request = async (method, params) => {
    if (method === 'session.resume') {
      return {
        session_id: 'S1', stored_session_id: 'S1', messages: [], message_count: 1, running: false,
        revision: 1, execution_generation: 1, execution_state: 'idle', info: { cwd: '/srv/scratch', profile_name: 'work' },
      };
    }
    if (method === 'session.mutate') {
      await gate;
      throw new Error('WebSocket is not open');
    }
    return { projects: [], active_id: null, scoped_session_ids: [] };
  };
  const { container, controller } = setup({ rows, request });
  await controller.activate();
  await controller.startMove({ id: 'S1', title: 'Fix', cwd: '/srv/scratch' });
  controller.chooseMoveTarget('custom');
  controller.setMoveCustomPath('/srv/atlas');
  const done = controller.confirmMove();
  await wait();
  assert.equal(controller.state.move.step, 'working');
  const back = container.querySelector('[data-fk="back"]');
  assert.equal(back.hasAttribute('disabled'), true, 'Back is off while the move commits');
  release();
  await done;
  assert.notEqual(controller.state.move.step, 'working');
  assert.equal(container.querySelector('[data-fk="back"]').hasAttribute('disabled'), false, 'and back on when it has an answer');
});

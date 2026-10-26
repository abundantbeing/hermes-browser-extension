import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HOST_FOLDER_METHODS,
  HOST_FOLDER_PAGE,
  baseName,
  breadcrumbs,
  createHostFolderBrowser,
  folderCompletionWord,
  foldersFromCompletion,
  joinHostPath,
  parentPath,
  samePathLoose,
  separatorFor,
} from '../extension/lib/host-folders.mjs';

const BS = String.fromCharCode(92);
const win = (...parts) => parts.join(BS);

test('breadcrumbs split a POSIX path from the root', () => {
  assert.deepEqual(breadcrumbs('/home/ana/code/'), [
    { label: '/', path: '/' },
    { label: 'home', path: '/home' },
    { label: 'ana', path: '/home/ana' },
    { label: 'code', path: '/home/ana/code' },
  ]);
  assert.deepEqual(breadcrumbs('/'), [{ label: '/', path: '/' }]);
  assert.equal(parentPath('/home/ana'), '/home');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/'), '/');
});

test('breadcrumbs treat a drive or share as the root of a Windows host path', () => {
  const path = win('C:', 'Users', 'ana', 'code');
  assert.deepEqual(breadcrumbs(path).map((crumb) => crumb.path), [win('C:', ''), win('C:', 'Users'), win('C:', 'Users', 'ana'), path]);
  assert.equal(parentPath(win('C:', 'Users')), win('C:', ''));
  assert.equal(parentPath(win('C:', '')), win('C:', ''));
  assert.equal(separatorFor(path), BS);
  assert.equal(separatorFor('C:/Users/ana'), '/');
  const share = `${BS}${BS}srv${BS}data${BS}team`;
  assert.deepEqual(breadcrumbs(share).map((crumb) => crumb.path), [`${BS}${BS}srv${BS}data`, share]);
});

test('joining and naming keep the host separator', () => {
  assert.equal(joinHostPath('/', 'etc'), '/etc');
  assert.equal(joinHostPath('/home/ana/', 'code'), '/home/ana/code');
  assert.equal(joinHostPath(win('C:', ''), 'src'), win('C:', 'src'));
  assert.equal(joinHostPath(win('C:', 'Users'), 'ana'), win('C:', 'Users', 'ana'));
  assert.equal(baseName('/home/ana/code/'), 'code');
  assert.equal(baseName(win('C:', 'Users', 'ana')), 'ana');
  assert.ok(samePathLoose('/srv/app/', '/srv/app'));
  assert.ok(samePathLoose(win('C:', 'Src'), 'c:/src'));
});

test('the completion word asks for folders only, with forward slashes, under the directory', () => {
  assert.equal(folderCompletionWord('/home/ana'), '@folder:/home/ana/');
  assert.equal(folderCompletionWord('/', 'sr'), '@folder:/sr');
  assert.equal(folderCompletionWord(win('C:', 'Users', 'ana'), 'co'), '@folder:C:/Users/ana/co');
});

test('folders come from each row\'s display name, sorted, deduplicated, never traversing', () => {
  const payload = { items: [
    { text: '@folder:b/', display: 'b/', meta: 'dir' },
    { text: '@folder:a/', display: 'a/', meta: 'dir' },
    { text: '@folder:a/', display: 'a/', meta: 'dir' },
    { text: '@folder:../x/', display: '../', meta: 'dir' },
    { text: '@folder:x/y/', display: 'x/y/', meta: 'dir' },
    { text: '@file:z', display: 'z', meta: 'file' },
  ] };
  assert.deepEqual(foldersFromCompletion('/srv', payload), [
    { name: 'a', path: '/srv/a' },
    { name: 'b', path: '/srv/b' },
  ]);
  assert.deepEqual(foldersFromCompletion('/srv', null), []);
});

function makeRequest(handlers, calls = []) {
  return async (method, params) => {
    calls.push([method, params]);
    const handler = handlers[method];
    if (!handler) throw Object.assign(new Error('unknown method'), { rpcCode: -32601, data: { reason: 'unknown_method' } });
    return handler(params);
  };
}

test('listing sends one complete.path call with the live session and profile, and reports a full page', async () => {
  const calls = [];
  const items = Array.from({ length: HOST_FOLDER_PAGE }, (_, index) => ({ text: `@folder:d${index}/`, display: `d${index}/`, meta: 'dir' }));
  const browser = createHostFolderBrowser({
    request: makeRequest({ [HOST_FOLDER_METHODS.complete]: () => ({ items }) }, calls),
    getSessionId: () => 'S1',
    profile: 'work',
  });
  const result = await browser.list('/srv', { filter: 'd' });
  assert.equal(result.ok, true);
  assert.equal(result.folders.length, HOST_FOLDER_PAGE);
  assert.equal(result.truncated, true);
  assert.deepEqual(calls, [[HOST_FOLDER_METHODS.complete, { word: '@folder:/srv/d', session_id: 'S1', profile: 'work' }]]);
});

test('listing without a session sends no session id, and a short page is complete', async () => {
  const calls = [];
  const browser = createHostFolderBrowser({
    request: makeRequest({ [HOST_FOLDER_METHODS.complete]: () => ({ items: [{ display: 'a/', meta: 'dir' }] }) }, calls),
  });
  const result = await browser.list('/srv');
  assert.equal(result.truncated, false);
  assert.equal('session_id' in calls[0][1], false);
  assert.equal('profile' in calls[0][1], false);
});

test('a gateway that cannot list answers a reason, never throws', async () => {
  const none = createHostFolderBrowser({ request: makeRequest({}) });
  assert.equal((await none.list('/srv')).reason, 'unsupported');
  const gone = createHostFolderBrowser({
    request: makeRequest({ [HOST_FOLDER_METHODS.complete]: () => { throw Object.assign(new Error('session not_found'), { data: { reason: 'not_found' } }); } }),
  });
  assert.equal((await gone.list('/srv')).reason, 'no-session');
  const slow = createHostFolderBrowser({
    request: makeRequest({ [HOST_FOLDER_METHODS.complete]: () => { throw new Error('Request timed out'); } }),
  });
  assert.equal((await slow.list('/srv')).reason, 'timeout');
  const odd = createHostFolderBrowser({ request: makeRequest({ [HOST_FOLDER_METHODS.complete]: () => ({}) }) });
  assert.equal((await odd.list('/srv')).reason, 'failed');
  assert.equal((await odd.list('')).ok, false);
});

test('roots are the host home and default folder first, then known repos, without repeats', async () => {
  const calls = [];
  const browser = createHostFolderBrowser({
    profile: 'work',
    request: makeRequest({
      [HOST_FOLDER_METHODS.forCwd]: (params) => ({ cwd: params.cwd === '~' ? '/home/ana' : '/home/ana/work', project: null, branch: '' }),
      [HOST_FOLDER_METHODS.discover]: () => ({ repos: [
        { root: '/home/ana/work', label: 'work', sessions: 1, last_active: 1 },
        { root: '/srv/atlas', label: 'Atlas', sessions: 2, last_active: 2 },
        { root: '/srv/zeta', label: '', sessions: 0, last_active: 0 },
        { label: 'no root' },
      ] }),
    }, calls),
  });
  const roots = await browser.roots();
  assert.deepEqual(roots.map((root) => [root.kind, root.path, root.label]), [
    ['home', '/home/ana', ''],
    ['default', '/home/ana/work', ''],
    ['repo', '/srv/atlas', 'Atlas'],
    ['repo', '/srv/zeta', 'zeta'],
  ]);
  assert.deepEqual(calls.map(([method, params]) => [method, params.profile]), [
    [HOST_FOLDER_METHODS.forCwd, 'work'], [HOST_FOLDER_METHODS.forCwd, 'work'], [HOST_FOLDER_METHODS.discover, 'work'],
  ]);
});

test('a source that fails is left out of the roots', async () => {
  const browser = createHostFolderBrowser({
    request: makeRequest({ [HOST_FOLDER_METHODS.forCwd]: () => ({ cwd: '/home/ana' }) }),
  });
  const roots = await browser.roots();
  assert.deepEqual(roots.map((root) => root.kind), ['home']);
  const empty = createHostFolderBrowser({ request: makeRequest({}) });
  assert.deepEqual(await empty.roots(), []);
});

test('a request function is required', () => {
  assert.throws(() => createHostFolderBrowser({}), TypeError);
});

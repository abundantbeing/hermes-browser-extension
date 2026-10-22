// The Projects tab's state machine.
//
// No DOM and no sidepanel globals: the panel hands in how to reach the
// connection (`getConnection`), how to open or create a session, and a change
// callback. All gateway logic is the committed projects-client and
// session-mutate modules; this file decides what the drawer shows while those
// calls are in flight, which answers are stale, and what happens after a move.
//
// Identity: the client (and with it the cache and the record of unsupported
// methods) is rebuilt whenever the endpoint, principal, profile or socket
// changes, and every async answer is dropped if the identity moved while it was
// in flight, so one connection's projects are never shown under another's.

import {
  PROJECTS_METHODS,
  createProjectsClient,
  gatewayAuthorityAvailability,
  projectsIdentity,
} from './projects-client.mjs';
import { SESSION_MUTATE_METHOD, moveSessionToWorkspace, samePath } from './session-mutate.mjs';
import {
  buildProjectRows,
  describeMoveOutcome,
  describeProjectsFailure,
  moveTargetsFor,
  validateMovePath,
  validateProjectDraft,
} from './projects-view.mjs';

const TREE_PREVIEW_LIMIT = 3;
const PROJECT_SESSION_LIMIT = 200;

function clean(value = '') {
  return String(value ?? '').trim();
}

function freshState() {
  return {
    view: 'list', // list | project | create | move
    scope: null,
    query: '',
    list: { status: 'idle', rows: [], hasCounts: true, failure: null, notice: null, loadedAt: 0 },
    project: null,
    create: null,
    move: null,
    notice: null,
  };
}

/**
 * @param {object} options
 * @param {() => object|null} options.getConnection  { token, identityInput, dashboardWs, request, getReadyPayload, connectError }
 * @param {() => Promise<void>} [options.prepareConnection]  tries to open the dashboard socket when one is expected
 * @param {(session: object) => any} options.openSession  open a session in the chat
 * @param {(args: {cwd: string, projectName: string}) => Promise<any>} options.createSessionInFolder
 * @param {(move: object) => void} [options.onSessionMoved]  a move was read back and committed
 * @param {() => void} options.onChange
 */
export function createProjectsController({
  getConnection,
  prepareConnection = async () => {},
  openSession,
  createSessionInFolder,
  onSessionMoved = () => {},
  onChange = () => {},
} = {}) {
  let state = freshState();
  let entry = null; // { key, client, request, unsupported, connection }
  let generation = 0;
  let loadSerial = 0;

  function emit() {
    onChange(state);
  }

  function set(patch) {
    state = { ...state, ...patch };
    emit();
  }

  function setList(patch) {
    state = { ...state, list: { ...state.list, ...patch } };
  }

  // ---- Identity ---------------------------------------------------------

  function resolve() {
    const connection = getConnection?.() || null;
    const identity = connection ? projectsIdentity(connection.identityInput) : null;
    const key = identity ? `${identity.key}|${connection.dashboardWs === true}` : 'none';
    if (!entry || entry.key !== key || entry.token !== (connection?.token ?? null)) {
      generation += 1;
      const unsupported = new Set();
      const request = (method, params) => {
        if (!connection?.request) return Promise.reject(new Error('Hermes dashboard is not connected.'));
        return connection.request(method, params);
      };
      entry = {
        key,
        token: connection?.token ?? null,
        connection,
        unsupported,
        request,
        client: createProjectsClient({
          request,
          dashboardWs: connection?.dashboardWs === true,
          getReadyPayload: () => connection?.getReadyPayload?.() || null,
          endpoint: connection?.identityInput?.endpoint || '',
          principal: connection?.identityInput?.principal || '',
          profile: connection?.identityInput?.profile || '',
        }),
      };
      state = {
        ...freshState(),
        query: state.query,
        scope: identity ? { profile: identity.profile, endpoint: identity.endpoint } : null,
      };
    }
    entry.connection = connection;
    return entry;
  }

  /** Whether Projects works on this connection right now, with the exact reason. */
  function availability(method = SESSION_MUTATE_METHOD) {
    const current = resolve();
    return gatewayAuthorityAvailability({
      dashboardWs: current.connection?.dashboardWs === true,
      readyPayload: current.connection?.getReadyPayload?.() || null,
      unsupportedMethods: current.unsupported,
      method,
    });
  }

  function stillCurrent(token) {
    return token === generation;
  }

  // ---- List -------------------------------------------------------------

  async function loadList({ force = false } = {}) {
    const serial = ++loadSerial;
    const current = resolve();
    const token = generation;
    const gate = availability(PROJECTS_METHODS.list);
    if (!gate.available) {
      setList({
        status: 'unavailable',
        rows: [],
        failure: describeProjectsFailure({ ...gate, unavailable: true }),
        connectError: clean(current.connection?.connectError),
      });
      emit();
      return;
    }
    setList({ status: state.list.rows.length ? 'refreshing' : 'loading', failure: null, notice: null });
    emit();
    const [listed, tree] = await Promise.all([
      current.client.list({ force }),
      current.client.tree({ previewLimit: TREE_PREVIEW_LIMIT, force }),
    ]);
    if (!stillCurrent(token) || serial !== loadSerial) return;
    if (!listed.ok && !tree.ok) {
      const failure = describeProjectsFailure(listed.unavailable ? listed : tree);
      setList({ status: failure.unavailable ? 'unavailable' : 'error', rows: [], failure });
      emit();
      return;
    }
    const rows = buildProjectRows({ list: listed.ok ? listed.data : null, tree: tree.ok ? tree.data : null });
    setList({
      status: 'ready',
      rows,
      hasCounts: tree.ok,
      failure: null,
      notice: !tree.ok ? describeProjectsFailure(tree) : (!listed.ok ? describeProjectsFailure(listed) : null),
      loadedAt: Date.now(),
    });
    emit();
  }

  async function activate({ force = false } = {}) {
    try {
      await prepareConnection();
    } catch {
      // The reason is reported through the gate below.
    }
    resolve();
    if (state.view === 'project' && state.project) {
      await Promise.all([loadList({ force }), loadProject(state.project.id, { force })]);
      return;
    }
    await loadList({ force });
  }

  function refresh() {
    return activate({ force: true });
  }

  function setQuery(query) {
    state = { ...state, query: String(query ?? '') };
    emit();
  }

  // ---- A project's sessions --------------------------------------------

  async function loadProject(id, { force = false } = {}) {
    const current = resolve();
    const token = generation;
    const row = state.list.rows.find((item) => item.id === id) || null;
    const previous = state.project?.id === id ? state.project : null;
    state = {
      ...state,
      view: 'project',
      project: {
        id,
        row,
        name: row?.name || previous?.name || id,
        status: previous?.node ? 'refreshing' : 'loading',
        node: previous?.node || null,
        failure: null,
      },
    };
    emit();
    const gate = availability(PROJECTS_METHODS.projectSessions);
    if (!gate.available) {
      state = { ...state, project: { ...state.project, status: 'unavailable', failure: describeProjectsFailure({ ...gate, unavailable: true }) } };
      emit();
      return;
    }
    const result = await current.client.projectSessions(id, { sessionLimit: PROJECT_SESSION_LIMIT, force });
    if (!stillCurrent(token) || state.project?.id !== id) return;
    if (!result.ok) {
      const failure = describeProjectsFailure(result);
      state = { ...state, project: { ...state.project, status: failure.unavailable ? 'unavailable' : 'error', failure } };
      emit();
      return;
    }
    const node = result.data.project;
    state = { ...state, project: { ...state.project, status: 'ready', node, failure: null } };
    emit();
  }

  function openProject(id) {
    state = { ...state, query: '', notice: null };
    return loadProject(id);
  }

  function back() {
    const returnTo = state.move?.returnTo || 'list';
    if (state.view === 'move') {
      state = { ...state, view: returnTo === 'project' && state.project ? 'project' : 'list', move: null };
    } else {
      state = { ...state, view: 'list', project: null, create: null, query: '' };
    }
    emit();
  }

  function dismissNotice() {
    set({ notice: null });
  }

  // ---- Create -----------------------------------------------------------

  function startCreate() {
    resolve();
    set({
      view: 'create',
      notice: null,
      create: { name: '', path: '', status: 'editing', error: null, touched: false },
    });
  }

  function updateCreate(field, value) {
    if (!state.create || state.create.status === 'submitting') return;
    state = { ...state, create: { ...state.create, [field]: String(value ?? ''), error: null } };
    emit();
  }

  function draftCheck() {
    return validateProjectDraft({ name: state.create?.name, path: state.create?.path }, state.list.rows);
  }

  async function submitCreate() {
    const draft = state.create;
    if (!draft || draft.status === 'submitting') return;
    const check = draftCheck();
    if (!check.ok) {
      state = { ...state, create: { ...draft, touched: true } };
      emit();
      return;
    }
    const current = resolve();
    const token = generation;
    const name = clean(draft.name);
    const path = clean(draft.path);
    state = { ...state, create: { ...draft, status: 'submitting', error: null, touched: true } };
    emit();
    let result = await current.client.create({ name, folders: [path], primaryPath: path });
    if (!stillCurrent(token)) return;
    if (!result.ok && (result.reason === 'timeout' || result.reason === 'disconnected')) {
      // The gateway may have committed the row before the answer was lost.
      // Resending would hit the duplicate-folder refusal, so read first.
      await loadList({ force: true });
      if (!stillCurrent(token)) return;
      const landed = state.list.rows.find((row) => row.kind === 'project' && samePath(row.path, path));
      if (landed) result = { ok: true, data: { project: { id: landed.id, name: landed.name } }, recovered: true };
    }
    if (!result.ok) {
      const failure = describeProjectsFailure(result);
      state = { ...state, create: { ...state.create, status: 'editing', error: failure } };
      emit();
      return;
    }
    const created = result.data.project;
    state = {
      ...state,
      create: null,
      notice: { tone: 'ok', key: 'projects.create.done', params: { name: created.name } },
    };
    await loadList({ force: true });
    if (!stillCurrent(token)) return;
    await loadProject(created.id, { force: true });
  }

  // ---- Move to project --------------------------------------------------

  async function startMove(session, { returnTo = 'list' } = {}) {
    const id = clean(session?.id);
    if (!id) return;
    resolve();
    state = {
      ...state,
      view: 'move',
      notice: null,
      move: {
        session: { id, title: clean(session.title) || id, cwd: clean(session.cwd) },
        returnTo,
        targetId: '',
        customPath: '',
        step: 'choose', // choose | working | confirm-live | result
        outcome: null,
        pending: null,
        folderCheck: null,
        pathError: '',
      },
    };
    emit();
    const gate = availability(SESSION_MUTATE_METHOD);
    if (gate.available && (state.list.status === 'idle' || state.list.status === 'unavailable')) await loadList();
  }

  function chooseMoveTarget(targetId) {
    if (!state.move || state.move.step === 'working') return;
    state = { ...state, move: { ...state.move, targetId: clean(targetId), pathError: '', outcome: null, step: 'choose', folderCheck: null } };
    emit();
  }

  function setMoveCustomPath(value) {
    if (!state.move || state.move.step === 'working') return;
    state = { ...state, move: { ...state.move, targetId: 'custom', customPath: String(value ?? ''), pathError: '', folderCheck: null } };
    emit();
  }

  function moveTargets() {
    return moveTargetsFor(state.list.rows, { currentCwd: state.move?.session.cwd });
  }

  function moveDestination() {
    const move = state.move;
    if (!move) return null;
    if (move.targetId === 'custom') {
      return { cwd: clean(move.customPath), label: clean(move.customPath), custom: true };
    }
    const target = moveTargets().find((item) => item.id === move.targetId);
    return target ? { cwd: target.cwd, label: target.label, custom: false } : null;
  }

  /** Ask the gateway which project (if any) a typed folder belongs to. */
  async function checkCustomFolder() {
    const move = state.move;
    if (!move || move.targetId !== 'custom') return;
    const error = validateMovePath(move.customPath);
    if (error) {
      state = { ...state, move: { ...move, pathError: error } };
      emit();
      return;
    }
    const current = resolve();
    const token = generation;
    state = { ...state, move: { ...move, folderCheck: { status: 'checking' }, pathError: '' } };
    emit();
    const result = await current.client.forCwd(move.customPath);
    if (!stillCurrent(token) || !state.move || state.move.customPath !== move.customPath) return;
    state = {
      ...state,
      move: {
        ...state.move,
        folderCheck: result.ok
          ? { status: 'ok', projectName: result.data.project?.name || '', cwd: result.data.cwd }
          : { status: 'failed', failure: describeProjectsFailure(result) },
      },
    };
    emit();
  }

  async function runMove({ confirmLiveTurn = false, pending = null } = {}) {
    const move = state.move;
    if (!move || move.step === 'working') return;
    const destination = moveDestination();
    if (!destination) return;
    const pathError = validateMovePath(destination.cwd);
    if (pathError) {
      state = { ...state, move: { ...move, pathError } };
      emit();
      return;
    }
    const current = resolve();
    const token = generation;
    state = { ...state, move: { ...move, step: 'working', pathError: '', outcome: null } };
    emit();
    let result;
    try {
      result = await moveSessionToWorkspace({
        request: current.request,
        dashboardWs: current.connection?.dashboardWs === true,
        getReadyPayload: () => current.connection?.getReadyPayload?.() || null,
        unsupportedMethods: current.unsupported,
        sessionId: move.session.id,
        cwd: destination.cwd,
        confirmLiveTurn,
        pending,
      });
    } catch (error) {
      result = { status: 'failed', reason: 'exception', message: clean(error?.message) };
    }
    if (!stillCurrent(token) || state.view !== 'move' || state.move?.session.id !== move.session.id) return;
    const outcome = describeMoveOutcome(result);
    const step = outcome.confirmable ? 'confirm-live' : 'result';
    state = {
      ...state,
      move: {
        ...state.move,
        step,
        outcome: { ...outcome, destinationLabel: destination.label },
        pending: result.pending || null,
        session: result.status === 'moved' ? { ...state.move.session, cwd: result.cwd } : state.move.session,
      },
    };
    emit();
    if (result.status === 'moved') {
      current.client.invalidate();
      try {
        onSessionMoved({ sessionId: move.session.id, cwd: result.cwd, previousCwd: result.previousCwd });
      } catch {
        // The drawer refresh below does not depend on the host's hook.
      }
      await loadList({ force: true });
      if (stillCurrent(token) && state.project) await loadProject(state.project.id, { force: true });
    }
  }

  function confirmMove() {
    return runMove({ confirmLiveTurn: state.move?.step === 'confirm-live' });
  }

  function reconcileMove() {
    const pending = state.move?.pending;
    if (!pending) return confirmMove();
    return runMove({ pending, confirmLiveTurn: false });
  }

  function cancelLiveConfirm() {
    if (!state.move) return;
    state = { ...state, move: { ...state.move, step: 'choose', outcome: null } };
    emit();
  }

  // ---- Sessions ---------------------------------------------------------

  async function openProjectSession(session) {
    return openSession(session);
  }

  async function newSessionInProject(row) {
    const target = row || state.project?.row;
    const cwd = clean(target?.cwd);
    if (!cwd) return false;
    const token = generation;
    try {
      await createSessionInFolder({ cwd, projectName: target.name });
      return true;
    } catch (error) {
      if (stillCurrent(token)) {
        set({ notice: { tone: 'error', key: 'projects.new_session.failed', params: { detail: clean(error?.message) } } });
      }
      return false;
    }
  }

  return {
    get state() { return state; },
    availability,
    resolve,
    activate,
    refresh,
    setQuery,
    openProject,
    back,
    dismissNotice,
    startCreate,
    updateCreate,
    draftCheck,
    submitCreate,
    startMove,
    chooseMoveTarget,
    setMoveCustomPath,
    moveTargets,
    moveDestination,
    checkCustomFolder,
    confirmMove,
    reconcileMove,
    cancelLiveConfirm,
    openProjectSession,
    newSessionInProject,
  };
}

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
  isCallerBlockedReason,
  createProjectsClient,
  gatewayAuthorityAvailability,
  projectsIdentity,
} from './projects-client.mjs';
import { SESSION_MUTATE_METHOD, moveSessionToWorkspace, samePath } from './session-mutate.mjs';
import { baseName, createHostFolderBrowser } from './host-folders.mjs';
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
// Results worth a notice when the move view is no longer on screen: the move
// happened, or it may have (nothing else changed anything).
const MOVE_NOTICE_STATUSES = new Set(['moved', 'indeterminate', 'conflict', 'unconfirmed']);

function clean(value = '') {
  return String(value ?? '').trim();
}

function freshState() {
  return {
    view: 'list', // list | project | create | move | picker
    scope: null,
    query: '',
    list: { status: 'idle', rows: [], hasCounts: true, failure: null, notice: null, loadedAt: 0 },
    project: null,
    create: null,
    move: null,
    picker: null, // the folder picker over the create form or the move view
    // The idea typed into a project that was just created, until it is saved as IDEA.md in a session.
    pendingIdea: null,
    notice: null,
  };
}

/**
 * @param {object} options
 * @param {() => object|null} options.getConnection  { token, identityInput, dashboardWs, request, getReadyPayload, connectError, blockedReason }
 * @param {() => Promise<void>} [options.prepareConnection]  tries to open the dashboard socket when one is expected
 * @param {(session: object) => any} options.openSession  open a session in the chat
 * @param {(args: {cwd: string, projectName: string}) => Promise<any>} options.createSessionInFolder
 * @param {(move: object) => void} [options.onSessionMoved]  a move was read back and committed
 * @param {() => void} [options.onReturnToRecents]  Back from a move that was started in Recents
 * @param {() => Promise<any>} [options.signInWithAccount]  runs the Hermes account sign-in; offered on the unavailable card
 * @param {() => void} options.onChange
 */
export function createProjectsController({
  getConnection,
  prepareConnection = async () => {},
  openSession,
  createSessionInFolder,
  onSessionMoved = () => {},
  onReturnToRecents = () => {},
  signInWithAccount = null,
  onChange = () => {},
} = {}) {
  let state = freshState();
  let entry = null; // { key, client, request, unsupported, connection }
  let generation = 0;
  let loadSerial = 0;
  let pickerSerial = 0;
  let ideaSerial = 0;

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
      const holder = { connection };
      const request = (method, params) => {
        if (!holder.connection?.request) return Promise.reject(new Error('Hermes dashboard is not connected.'));
        return holder.connection.request(method, params);
      };
      // Folders on the gateway host, read through the same socket the projects are read on.
      const folders = createHostFolderBrowser({
        request,
        getSessionId: () => holder.connection?.getSessionId?.() || '',
        profile: connection?.identityInput?.profile || '',
      });
      entry = {
        key,
        token: connection?.token ?? null,
        holder,
        connection,
        unsupported,
        request,
        folders,
        client: createProjectsClient({
          request,
          dashboardWs: connection?.dashboardWs === true,
          getReadyPayload: () => holder.connection?.getReadyPayload?.() || null,
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
    entry.holder.connection = connection;
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
      blockedReason: current.connection?.blockedReason,
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
        // The sign-in reason is its own message; the raw connect error would only repeat it.
        connectError: isCallerBlockedReason(gate.reason) ? '' : clean(current.connection?.connectError),
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

  // The Sign in with your Hermes account button on the unavailable card: sign in, then read Projects again.
  async function accountSignIn() {
    if (typeof signInWithAccount !== 'function') return;
    try {
      await signInWithAccount();
    } finally {
      await refresh();
    }
  }

  function setQuery(query) {
    state = { ...state, query: String(query ?? '') };
    emit();
  }

  // ---- A project's sessions --------------------------------------------

  async function loadProject(id, { force = false, keepView = false } = {}) {
    const current = resolve();
    const token = generation;
    const row = state.list.rows.find((item) => item.id === id) || null;
    const previous = state.project?.id === id ? state.project : null;
    state = {
      ...state,
      view: keepView ? state.view : 'project',
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
    // A move that is being committed owns the view until the gateway answers.
    if (state.move?.step === 'working') return;
    // The folder picker sits over the form or move view it was opened from: Back closes just the picker.
    if (state.view === 'picker') {
      closePicker();
      return;
    }
    const returnTo = state.move?.returnTo || 'list';
    if (state.view === 'move') {
      state = { ...state, view: returnTo === 'project' && state.project ? 'project' : 'list', move: null, query: '' };
      if (returnTo === 'recents') {
        emit();
        onReturnToRecents();
        return;
      }
    } else {
      state = { ...state, view: 'list', project: null, create: null, picker: null, query: '' };
    }
    emit();
  }

  /** Back to the project list with nothing half-open: used each time the drawer opens. */
  function resetView() {
    if (state.move?.step === 'working') return;
    pickerSerial += 1;
    state = { ...state, view: 'list', project: null, create: null, move: null, picker: null, notice: null, query: '' };
  }

  function dismissNotice() {
    set({ notice: null });
  }

  // ---- Create -----------------------------------------------------------

  function startCreate() {
    resolve();
    ideaSerial += 1;
    set({
      view: 'create',
      notice: null,
      picker: null,
      // `path` is the folder being typed; `folders` are the ones already added (the first is the primary).
      create: {
        name: '', path: '', folders: [], idea: '', ideaStatus: 'idle', ideaError: null,
        status: 'editing', error: null, touched: false,
      },
    });
  }

  function updateCreate(field, value) {
    if (!state.create || state.create.status === 'submitting') return;
    state = { ...state, create: { ...state.create, [field]: String(value ?? ''), error: null } };
    emit();
  }

  /** The folders a create would send: those added, then the typed path when it is not already among them. */
  function createFolders(draft = state.create) {
    const out = [];
    for (const entry of [...(draft?.folders || []), draft?.path]) {
      const value = clean(entry);
      if (value && !out.some((existing) => samePath(existing, value))) out.push(value);
    }
    return out;
  }

  function addCreateFolder(path) {
    const draft = state.create;
    const value = clean(path);
    if (!draft || draft.status === 'submitting' || !value) return;
    const folders = createFolders({ folders: draft.folders, path: value });
    // Like Desktop, the first folder names a project that has no name yet.
    const name = clean(draft.name) ? draft.name : (draft.folders.length ? draft.name : baseName(value));
    state = { ...state, create: { ...draft, folders, path: '', name, error: null } };
    emit();
  }

  function removeCreateFolder(path) {
    const draft = state.create;
    if (!draft || draft.status === 'submitting') return;
    const folders = draft.folders.filter((folder) => !samePath(folder, path));
    // Removing the folder that is still only typed clears the field.
    const typed = samePath(draft.path, path) ? '' : draft.path;
    state = { ...state, create: { ...draft, folders, path: typed, error: null } };
    emit();
  }

  /** Adds the typed path as a folder (Enter, or the Add button beside the typed-path field). */
  function addTypedFolder() {
    const draft = state.create;
    if (!draft) return;
    if (validateMovePath(draft.path)) {
      state = { ...state, create: { ...draft, touched: true } };
      emit();
      return;
    }
    addCreateFolder(draft.path);
  }

  function draftCheck() {
    return validateProjectDraft({ name: state.create?.name, path: state.create?.path, folders: state.create?.folders }, state.list.rows);
  }

  // Desktop's "Generate idea": one stateless llm.oneshot on the gateway's model. A failed or empty answer
  // leaves the text the person already wrote.
  async function generateIdea() {
    const draft = state.create;
    if (!draft || draft.ideaStatus === 'generating' || draft.status === 'submitting') return;
    const current = resolve();
    const token = generation;
    const serial = ++ideaSerial;
    state = { ...state, create: { ...draft, ideaStatus: 'generating', ideaError: null } };
    emit();
    const result = await current.client.generateIdea({ name: draft.name });
    if (!stillCurrent(token) || serial !== ideaSerial || !state.create) return;
    state = {
      ...state,
      create: result.ok
        ? { ...state.create, idea: result.data.text, ideaStatus: 'idle', ideaError: null }
        : { ...state.create, ideaStatus: 'idle', ideaError: describeProjectsFailure(result) },
    };
    emit();
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
    const folders = createFolders(draft);
    const path = folders[0];
    const idea = clean(draft.idea);
    state = { ...state, create: { ...draft, status: 'submitting', error: null, touched: true } };
    emit();
    let result = await current.client.create({ name, folders, primaryPath: path });
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
      view: 'list',
      create: null,
      picker: null,
      pendingIdea: idea ? { projectId: created.id, name: created.name, cwd: path, idea } : null,
      notice: { tone: 'ok', key: idea ? 'projects.create.done_idea' : 'projects.create.done', params: { name: created.name } },
    };
    await loadList({ force: true });
    if (!stillCurrent(token)) return;
    await loadProject(created.id, { force: true });
  }

  // The gateway has no file-write method a browser panel can reach (Desktop writes IDEA.md through a REST route
  // this panel holds no credential for), so the idea is saved the way any file is: a session in the project's
  // folder opens with the text ready, and Hermes writes IDEA.md when the person sends it.
  async function saveIdea() {
    const pending = state.pendingIdea;
    if (!pending) return false;
    const token = generation;
    try {
      await createSessionInFolder({ cwd: pending.cwd, projectName: pending.name, idea: pending.idea });
      if (stillCurrent(token)) set({ pendingIdea: null });
      return true;
    } catch (error) {
      if (stillCurrent(token)) {
        set({ notice: { tone: 'error', key: 'projects.new_session.failed', params: { detail: clean(error?.message) } } });
      }
      return false;
    }
  }

  function dropPendingIdea() {
    if (state.pendingIdea) set({ pendingIdea: null });
  }

  // ---- Folder picker ----------------------------------------------------

  function folderFailure(result) {
    if (result.reason === 'unsupported' || result.reason === 'no-session') {
      return { key: 'projects.picker.unsupported', params: {}, reason: result.reason };
    }
    return { key: 'projects.picker.failed', params: { detail: clean(result.message) }, reason: result.reason };
  }

  async function pickerNavigate(path, { filter = '' } = {}) {
    const picker = state.picker;
    const target = clean(path);
    if (!picker || !target) return;
    const error = validateMovePath(target);
    if (error) {
      state = { ...state, picker: { ...picker, pathError: error } };
      emit();
      return;
    }
    const current = resolve();
    const token = generation;
    const serial = ++pickerSerial;
    state = {
      ...state,
      picker: {
        ...picker,
        path: target,
        typed: target,
        filter,
        pathError: '',
        status: 'loading',
        failure: null,
        // A re-query of the same folder keeps what is on screen while the page narrows.
        folders: picker.path === target ? picker.folders : [],
      },
    };
    emit();
    const result = await current.folders.list(target, { filter: clean(filter) });
    if (!stillCurrent(token) || serial !== pickerSerial || !state.picker) return;
    state = {
      ...state,
      picker: result.ok
        ? { ...state.picker, status: 'ready', folders: result.folders, truncated: result.truncated, failure: null }
        : { ...state.picker, status: 'error', folders: [], truncated: false, failure: folderFailure(result) },
    };
    emit();
  }

  /** Opens the picker over the create form ('create') or the move view ('move'). */
  async function openFolderPicker(purpose) {
    if (!['create', 'move'].includes(purpose)) return;
    if (purpose === 'create' && !state.create) return;
    if (purpose === 'move' && (!state.move || state.move.step === 'working')) return;
    const current = resolve();
    const token = generation;
    const serial = ++pickerSerial;
    const returnView = state.view;
    // Start beside what is already chosen, else at the host's home.
    const startFrom = purpose === 'create'
      ? createFolders().slice(-1)[0] || ''
      : clean(state.move.customPath) || clean(state.move.session.cwd);
    state = {
      ...state,
      view: 'picker',
      picker: {
        purpose, returnView, path: '', typed: '', filter: '', pathError: '', status: 'loading', failure: null,
        folders: [], truncated: false, roots: [], rootsStatus: 'loading',
      },
    };
    emit();
    const roots = await current.folders.roots();
    if (!stillCurrent(token) || serial !== pickerSerial || !state.picker) return;
    state = { ...state, picker: { ...state.picker, roots, rootsStatus: 'ready' } };
    const first = startFrom || roots.find((root) => root.kind === 'home')?.path || roots[0]?.path || '';
    if (!first) {
      // Nothing the host can resolve: the typed path is the way in.
      state = {
        ...state,
        picker: { ...state.picker, status: 'error', failure: { key: 'projects.picker.unsupported', params: {}, reason: 'unsupported' } },
      };
      emit();
      return;
    }
    emit();
    await pickerNavigate(first);
  }

  function closePicker() {
    const picker = state.picker;
    pickerSerial += 1;
    let view = picker?.returnView === 'move' && state.move ? 'move' : 'create';
    if (view === 'create' && !state.create) view = 'list';
    state = { ...state, view, picker: null };
    emit();
  }

  function pickerSetTyped(value) {
    if (!state.picker) return;
    state = { ...state, picker: { ...state.picker, typed: String(value ?? ''), pathError: '' } };
    emit();
  }

  function pickerGo() {
    if (!state.picker) return Promise.resolve();
    return pickerNavigate(state.picker.typed);
  }

  /** The name filter narrows the loaded page at once; a full page is also re-read on the gateway by prefix. */
  function pickerFilter(value) {
    const picker = state.picker;
    if (!picker) return Promise.resolve();
    const filter = String(value ?? '');
    state = { ...state, picker: { ...picker, filter } };
    emit();
    if (!picker.truncated || !picker.path) return Promise.resolve();
    return pickerNavigate(picker.path, { filter });
  }

  /** Chooses the folder the picker is showing. */
  function pickerChoose() {
    const picker = state.picker;
    if (!picker || picker.status === 'loading') return;
    // A folder that could not be read (a gateway that cannot list) is still chosen by typing its path.
    const path = clean(picker.status === 'ready' ? picker.path : picker.typed);
    const error = path ? validateMovePath(path) : 'projects.move.path_required';
    if (error) {
      state = { ...state, picker: { ...picker, pathError: error } };
      emit();
      return;
    }
    pickerSerial += 1;
    if (picker.purpose === 'create') {
      state = { ...state, view: 'create', picker: null };
      addCreateFolder(path);
      return;
    }
    state = { ...state, view: 'move', picker: null };
    setMoveCustomPath(path);
    void checkCustomFolder();
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
    // The gateway decided this move whatever the drawer shows now (Back, a reopened
    // drawer and another session's Move pill all replace the view). What this
    // identity cached is stale either way, and while the identity is current the
    // host and the lists must still hear about a committed move.
    if (result.status === 'moved') current.client.invalidate();
    if (!stillCurrent(token)) return;
    const outcome = describeMoveOutcome(result);
    const onMoveView = state.view === 'move' && state.move?.session.id === move.session.id;
    if (onMoveView) {
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
    } else if (MOVE_NOTICE_STATUSES.has(result.status)) {
      // Nobody is looking at the result: say what happened where the drawer is now.
      state = {
        ...state,
        notice: { tone: outcome.tone === 'ok' ? 'ok' : 'error', key: outcome.key, params: outcome.params },
      };
      emit();
    }
    if (result.status === 'moved') {
      try {
        onSessionMoved({ sessionId: move.session.id, cwd: result.cwd, previousCwd: result.previousCwd });
      } catch {
        // The drawer refresh below does not depend on the host's hook.
      }
      await loadList({ force: true });
      if (stillCurrent(token) && state.project) await loadProject(state.project.id, { force: true, keepView: true });
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
    accountSignIn,
    canAccountSignIn: () => typeof signInWithAccount === 'function',
    setQuery,
    openProject,
    back,
    resetView,
    dismissNotice,
    startCreate,
    updateCreate,
    draftCheck,
    submitCreate,
    addCreateFolder,
    removeCreateFolder,
    addTypedFolder,
    generateIdea,
    saveIdea,
    dropPendingIdea,
    openFolderPicker,
    closePicker,
    pickerNavigate,
    pickerSetTyped,
    pickerGo,
    pickerFilter,
    pickerChoose,
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

// Browsing folders on the gateway host, over the socket the Projects tab already has.
//
// The folders a project or a session works in live on the machine that runs Hermes (this computer, a remote
// host, or Hermes Cloud), never in this browser. Desktop browses them through the dashboard's REST routes
// (`/api/fs/list`, `/api/fs/default-cwd`); the panel holds no HTTP credential for a gateway (it holds a socket
// ticket, an account sign-in or a paired token that only mint sockets), so this module uses the JSON-RPC
// methods the same socket serves:
//
//   projects.for_cwd       resolves "~" and the gateway's default folder to absolute host paths;
//   projects.discover_repos the git roots the host knows (session cwds and the repo scan);
//   complete.path          lists one directory (`@folder:<dir>/<prefix>` = folders only, at most 30). A session
//                          authority answers it for a live session only, rooted at that session's host.
//
// Nothing here touches the DOM or the network: `request(method, params)` is injected. Every call resolves to
// `{ ok: true, ... }` or `{ ok: false, reason, message }` and never throws.

export const HOST_FOLDER_METHODS = Object.freeze({
  forCwd: 'projects.for_cwd',
  discover: 'projects.discover_repos',
  complete: 'complete.path',
});

/** complete.path answers at most this many entries (tui_gateway/methods_complete.py). */
export const HOST_FOLDER_PAGE = 30;

const MAX_ROOTS = 12;

const BACKSLASH = String.fromCharCode(92);

function clean(value = '') {
  return String(value ?? '').trim();
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// ---- Paths ---------------------------------------------------------------

/** A Windows host path (`C:\x`, `C:/x`, a UNC share) versus a POSIX one. */
export function isWindowsHostPath(path = '') {
  const value = clean(path);
  return /^[A-Za-z]:([\\/]|$)/.test(value) || value.startsWith('\\\\');
}

export function separatorFor(path = '') {
  const value = clean(path);
  if (!isWindowsHostPath(value)) return '/';
  return value.includes('/') && !value.includes(BACKSLASH) ? '/' : BACKSLASH;
}

function trimTrailing(path) {
  const value = clean(path);
  if (value === '/' || /^[A-Za-z]:[\\/]?$/.test(value)) return value;
  return value.replace(/[\\/]+$/, '') || value.slice(0, 1);
}

/** `/home/ana/code` -> [{label:'/', path:'/'}, {label:'home', path:'/home'}, …]; a drive or share is the root. */
export function breadcrumbs(path = '') {
  const value = clean(path);
  if (!value) return [];
  const sep = separatorFor(value);
  const parts = value.split(/[\\/]+/).filter(Boolean);
  let acc;
  let rest;
  const out = [];
  if (isWindowsHostPath(value)) {
    if (value.startsWith(BACKSLASH + BACKSLASH)) {
      // A UNC share (two backslashes, server, share) is one root.
      if (parts.length < 2) return [{ label: value, path: value }];
      acc = `${BACKSLASH}${BACKSLASH}${parts[0]}${BACKSLASH}${parts[1]}`;
      rest = parts.slice(2);
    } else {
      acc = `${parts[0]}${sep}`;
      rest = parts.slice(1);
    }
    out.push({ label: acc, path: acc });
  } else {
    acc = '';
    rest = parts;
    out.push({ label: '/', path: '/' });
  }
  for (const part of rest) {
    acc = acc === '' || acc.endsWith(sep) ? `${acc}${acc === '' ? sep : ''}${part}` : `${acc}${sep}${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

export function parentPath(path = '') {
  const crumbs = breadcrumbs(path);
  if (crumbs.length <= 1) return crumbs[0]?.path || clean(path);
  return crumbs[crumbs.length - 2].path;
}

export function joinHostPath(dir = '', name = '') {
  const base = clean(dir);
  const leaf = clean(name).replace(/[\\/]+$/, '');
  if (!base) return leaf;
  const sep = separatorFor(base);
  return base.endsWith('/') || base.endsWith('\\') ? `${base}${leaf}` : `${base}${sep}${leaf}`;
}

export function baseName(path = '') {
  const crumbs = breadcrumbs(path);
  const last = crumbs[crumbs.length - 1];
  return last ? last.label.replace(/[\\/]+$/, '') || last.label : '';
}

export function samePathLoose(left = '', right = '') {
  const norm = (value) => trimTrailing(value).replace(/\\/g, '/').toLowerCase();
  return norm(left) === norm(right);
}

// ---- Failures ------------------------------------------------------------

function codeOf(error) {
  const code = Number(error?.rpcCode ?? error?.code);
  return Number.isFinite(code) ? code : null;
}

function describe(error) {
  const code = codeOf(error);
  const reason = clean(error?.data?.reason).toLowerCase();
  const message = clean(error?.message);
  if (code === -32601 || reason === 'unknown_method') return { reason: 'unsupported', message };
  if (reason === 'not_found' || /not[ _]found/i.test(message)) return { reason: 'no-session', message };
  if (/timed out/i.test(message)) return { reason: 'timeout', message };
  return { reason: 'failed', message };
}

// ---- Listing -------------------------------------------------------------

/**
 * Folder names out of a complete.path answer. Only directories are asked for (`@folder:`), and each item's
 * `display` is `name/`; a name that still holds a separator is a malformed row and is skipped.
 */
export function foldersFromCompletion(dir, payload = null) {
  const items = Array.isArray(asObject(payload).items) ? payload.items : [];
  const seen = new Set();
  const folders = [];
  for (const item of items) {
    const row = asObject(item);
    if (clean(row.meta) && clean(row.meta) !== 'dir') continue;
    const name = clean(row.display).replace(/\/+$/, '');
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || seen.has(name)) continue;
    seen.add(name);
    folders.push({ name, path: joinHostPath(dir, name) });
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** The `word` complete.path takes for the folders under `dir` whose names start with `prefix`. */
export function folderCompletionWord(dir, prefix = '') {
  const base = clean(dir).replace(/\\/g, '/');
  const withSlash = base.endsWith('/') ? base : `${base}/`;
  return `@folder:${withSlash}${clean(prefix)}`;
}

/**
 * @param {object} options
 * @param {(method: string, params: object) => Promise<any>} options.request
 * @param {() => string} [options.getSessionId]  a live session on this socket; a session authority lists only for one
 * @param {string} [options.profile]
 */
export function createHostFolderBrowser({ request, getSessionId = () => '', profile = '' } = {}) {
  if (typeof request !== 'function') throw new TypeError('A gateway request function is required.');
  const profileName = clean(profile);
  const withScope = (params = {}) => (profileName ? { ...params, profile: profileName } : params);

  async function resolveCwd(cwd) {
    try {
      const raw = asObject(await request(HOST_FOLDER_METHODS.forCwd, withScope(cwd ? { cwd } : {})));
      const resolved = clean(raw.cwd);
      return resolved ? { ok: true, path: resolved } : { ok: false, reason: 'failed', message: '' };
    } catch (error) {
      return { ok: false, ...describe(error) };
    }
  }

  return {
    /** The gateway's default folder. */
    defaultFolder() {
      return resolveCwd('');
    },

    /** The host user's home folder. */
    home() {
      return resolveCwd('~');
    },

    /**
     * Where a person starts: the host's home and default folder, then the git roots it knows. Each source that
     * fails is left out, so a gateway without one still offers the others.
     */
    async roots() {
      const [home, fallback] = await Promise.all([this.home(), this.defaultFolder()]);
      const roots = [];
      const add = (entry) => {
        if (!entry.path || roots.some((item) => samePathLoose(item.path, entry.path))) return;
        roots.push(entry);
      };
      if (home.ok) add({ id: 'home', kind: 'home', label: '', path: home.path });
      if (fallback.ok) add({ id: 'default', kind: 'default', label: '', path: fallback.path });
      let repos = [];
      try {
        const raw = asObject(await request(HOST_FOLDER_METHODS.discover, withScope({})));
        repos = Array.isArray(raw.repos) ? raw.repos : [];
      } catch {
        repos = [];
      }
      for (const repo of repos) {
        const row = asObject(repo);
        const path = clean(row.root);
        if (!path) continue;
        add({ id: `repo:${path}`, kind: 'repo', label: clean(row.label) || baseName(path), path });
        if (roots.length >= MAX_ROOTS) break;
      }
      return roots;
    },

    /**
     * The folders directly under `dir`. `filter` narrows by name prefix on the gateway, which is how a folder past
     * the first page is reached. `truncated` says a full page came back, so more may exist.
     */
    async list(dir, { filter = '' } = {}) {
      const path = clean(dir);
      if (!path) return { ok: false, reason: 'failed', message: '' };
      const params = withScope({ word: folderCompletionWord(path, filter) });
      const sessionId = clean(getSessionId?.());
      if (sessionId) params.session_id = sessionId;
      let raw;
      try {
        raw = await request(HOST_FOLDER_METHODS.complete, params);
      } catch (error) {
        return { ok: false, ...describe(error) };
      }
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) {
        return { ok: false, reason: 'failed', message: '' };
      }
      const folders = foldersFromCompletion(path, raw);
      return { ok: true, path, folders, truncated: raw.items.length >= HOST_FOLDER_PAGE };
    },
  };
}

/** The folders whose name holds `filter` (case-insensitive), in the order given. */
export function filterFolders(folders = [], filter = '') {
  const needle = clean(filter).toLowerCase();
  const list = Array.isArray(folders) ? folders : [];
  return needle ? list.filter((folder) => String(folder?.name || '').toLowerCase().includes(needle)) : list;
}

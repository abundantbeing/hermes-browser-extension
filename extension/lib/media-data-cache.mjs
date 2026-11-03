// A small in-memory memo for media data URLs the side panel downloads from the
// gateway. A transcript repaints while a turn streams and again when it settles,
// and every repaint asked for the same pictures again, so each picture was
// downloaded again as megabytes of base64. Entries are bounded, and a download
// that is already running is shared rather than repeated. Failed or empty loads
// are never stored, so the next caller retries.

export const DEFAULT_MEDIA_CACHE_ENTRIES = 8;
export const DEFAULT_MEDIA_CACHE_ENTRY_CHARS = 12_000_000;

export function createBoundedMediaCache({
  maxEntries = DEFAULT_MEDIA_CACHE_ENTRIES,
  maxEntryChars = DEFAULT_MEDIA_CACHE_ENTRY_CHARS,
} = {}) {
  const stored = new Map();
  const loading = new Map();

  function remember(key, value) {
    stored.delete(key);
    if (!value || value.length > maxEntryChars) return;
    stored.set(key, value);
    while (stored.size > maxEntries) stored.delete(stored.keys().next().value);
  }

  function getOrLoad(key, load) {
    if (stored.has(key)) {
      const value = stored.get(key);
      stored.delete(key);
      stored.set(key, value);
      return Promise.resolve(value);
    }
    if (loading.has(key)) return loading.get(key);
    // Start the load on a later microtask so a synchronous throw still reaches
    // the in-flight map before it is cleared.
    const pending = Promise.resolve()
      .then(load)
      .then((value) => {
        const text = typeof value === 'string' ? value : '';
        remember(key, text);
        return text;
      }, () => '')
      .finally(() => {
        loading.delete(key);
      });
    loading.set(key, pending);
    return pending;
  }

  return {
    getOrLoad,
    has: (key) => stored.has(key),
    get size() {
      return stored.size;
    },
    clear() {
      stored.clear();
    },
  };
}

export const GATEWAY_MEDIA_RETRY_MS = 10_000;
const MAX_REMEMBERED_FAILURES = 256;

// Reads stored pictures through the gateway's /api/media route, once per connection and
// path. `identity` names the connection a request is made as (gateway, profile and
// credential): a picture or a failure belongs to that connection only, so a switch of
// account or profile on the same gateway never sees the previous one's pictures or
// misses. 404 and 405 mean the route or the file is absent, which does not change while
// the panel is open, so that path is not asked again; any other failure waits
// `retryMs` before the next try.
export function createGatewayMediaReader({
  request,
  readJson = (response) => response.json(),
  now = () => Date.now(),
  retryMs = GATEWAY_MEDIA_RETRY_MS,
  cache = createBoundedMediaCache(),
} = {}) {
  if (typeof request !== 'function') throw new TypeError('request must be a function.');
  const retryAt = new Map();

  function retryLater(key, ms) {
    retryAt.delete(key);
    retryAt.set(key, now() + ms);
    while (retryAt.size > MAX_REMEMBERED_FAILURES) retryAt.delete(retryAt.keys().next().value);
  }

  async function download(filePath, key) {
    try {
      const response = await request(filePath);
      if (!response?.ok) {
        retryLater(key, response?.status === 404 || response?.status === 405 ? Infinity : retryMs);
        return '';
      }
      const payload = await readJson(response);
      const dataUrl = String(payload?.data_url || '').trim();
      if (!dataUrl.startsWith('data:image/')) {
        retryLater(key, retryMs);
        return '';
      }
      retryAt.delete(key);
      return dataUrl;
    } catch {
      retryLater(key, retryMs);
      return '';
    }
  }

  function read(filePath = '', identity = '') {
    const path = String(filePath || '').trim();
    if (!path) return Promise.resolve('');
    const key = JSON.stringify([String(identity || ''), path]);
    if (now() < (retryAt.get(key) || 0)) return Promise.resolve('');
    return cache.getOrLoad(key, () => download(path, key));
  }

  return {
    read,
    clear() {
      cache.clear();
      retryAt.clear();
    },
  };
}

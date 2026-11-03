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

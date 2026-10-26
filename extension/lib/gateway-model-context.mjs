// What the paired Hermes gateway itself reports as a model's context window.
//
// WHY THIS EXISTS: Hermes resolves a model's window at runtime (agent/model_metadata.py
// get_model_context_length: config pin, endpoint /models, the provider's live catalog,
// models.dev, and only then its built-in DEFAULT_CONTEXT_LENGTHS). That answer changes
// without an extension release (a provider raises or lowers a window, a new model ships),
// while any table bundled here is a snapshot. This version of Hermes does not put a window
// on /api/model/options, model.options or /v1/models rows, so the only places the gateway
// says one are:
//   * session.usage / session.stats / session.context_breakdown / session.info
//     (`context_max` / `context_length`, with the model the session runs),
//   * GET /api/model/info on the dashboard (the configured model's effective window).
// Each such reading is remembered here, per model, and every model row prefers it over the
// bundled table. The table stays as the last resort for models the gateway has not been
// asked about yet. A catalog row that carries its own window (a future gateway) still wins:
// see modelContextTokens in common.mjs.
//
// Pure module apart from the singleton at the bottom: no DOM, no storage, no sockets.

export const GATEWAY_MODEL_CONTEXT_STORAGE_KEY = 'hermesBrowserGatewayModelContext';
export const GATEWAY_MODEL_CONTEXT_VERSION = 1;
export const GATEWAY_MODEL_CONTEXT_MAX_ENTRIES = 200;
export const GATEWAY_MODEL_CONTEXT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOKENS = 100_000_000;

export const GATEWAY_CONTEXT_SOURCES = Object.freeze(['session-usage', 'session-breakdown', 'session-info', 'model-info', 'catalog']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** "openai-codex::OpenAI/GPT-6.1-Sol" -> "gpt-6.1-sol": what a gateway reports for the model it runs. */
export function bareModelId(value = '') {
  const raw = text(value).toLowerCase();
  if (!raw) return '';
  const afterProvider = raw.includes('::') ? raw.slice(raw.lastIndexOf('::') + 2) : raw;
  return afterProvider.split('/').pop().trim();
}

export function normalizeContextProvider(value = '') {
  return text(value).toLowerCase().replace(/[\s_]+/g, '-');
}

function positiveTokens(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= MAX_TOKENS ? Math.round(number) : 0;
}

function entryKey(provider, model) {
  return `${provider}::${model}`;
}

function modelIdentities(model = {}) {
  const ids = new Set();
  for (const field of [model.rawModelId, model.raw_model_id, model.model, model.id]) {
    const bare = bareModelId(field);
    if (bare) ids.add(bare);
  }
  return [...ids];
}

function rowProvider(model = {}) {
  return normalizeContextProvider(model.provider || model.providerLabel || model.provider_label || model.owned_by);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createGatewayModelContext({ now = Date.now } = {}) {
  let entries = {};
  let catalogSignature = '';
  // Bumped on every change a model row could show differently: views re-read on it.
  let revision = 0;

  function prune() {
    const cutoff = now() - GATEWAY_MODEL_CONTEXT_MAX_AGE_MS;
    const keys = Object.keys(entries);
    for (const key of keys) if (!(entries[key].at > cutoff)) delete entries[key];
    const left = Object.keys(entries);
    if (left.length > GATEWAY_MODEL_CONTEXT_MAX_ENTRIES) {
      left.sort((a, b) => entries[a].at - entries[b].at);
      for (const key of left.slice(0, left.length - GATEWAY_MODEL_CONTEXT_MAX_ENTRIES)) delete entries[key];
    }
  }

  return {
    get revision() { return revision; },
    get catalogSignature() { return catalogSignature; },

    /**
     * Remember one gateway reading. `provider` may be empty (a usage frame names the model only).
     * @returns {boolean} whether the stored answer changed
     */
    record({ model = '', provider = '', tokens = 0, source = 'session-usage' } = {}) {
      const bare = bareModelId(model);
      const window = positiveTokens(tokens);
      if (!bare || !window || ['__proto__', 'constructor', 'prototype'].includes(bare)) return false;
      const key = entryKey(normalizeContextProvider(provider), bare);
      const previous = Object.hasOwn(entries, key) ? entries[key] : null;
      entries[key] = { tokens: window, source: GATEWAY_CONTEXT_SOURCES.includes(source) ? source : 'session-usage', at: now() };
      prune();
      if (previous?.tokens === window) return false;
      revision += 1;
      return true;
    },

    /**
     * The gateway's window for a model row, or 0. A reading that names this row's provider wins;
     * a reading with no provider applies to any row of that model; a reading for a DIFFERENT
     * provider never does (the same model has different windows per provider).
     */
    lookup(model = {}) {
      const provider = rowProvider(model);
      let best = null;
      for (const bare of modelIdentities(model)) {
        const specific = provider && Object.hasOwn(entries, entryKey(provider, bare)) ? entries[entryKey(provider, bare)] : null;
        if (specific) return specific.tokens;
        const generic = Object.hasOwn(entries, entryKey('', bare)) ? entries[entryKey('', bare)] : null;
        if (generic && (!best || generic.at > best.at)) best = generic;
        if (!provider) {
          for (const [key, value] of Object.entries(entries)) {
            if (key.endsWith(`::${bare}`) && (!best || value.at > best.at)) best = value;
          }
        }
      }
      return best ? best.tokens : 0;
    },

    /** One line per remembered model, for diagnostics. */
    list() {
      return Object.entries(entries).map(([key, value]) => {
        const at = key.indexOf('::');
        return { provider: key.slice(0, at), model: key.slice(at + 2), ...value };
      });
    },

    /**
     * Compare the model catalog just read with the last one. A changed set of models (Hermes
     * updated, a provider added or dropped a model) says the gateway's windows may have moved.
     * @returns {boolean} true when the catalog differs from the last one seen
     */
    noteCatalog(models = []) {
      const ids = (Array.isArray(models) ? models : [])
        .map((model) => `${rowProvider(model)}::${bareModelId(model?.rawModelId || model?.id)}`)
        .filter((id) => !id.endsWith('::'))
        .sort();
      if (!ids.length) return false;
      let hash = 5381;
      const joined = ids.join('|');
      for (let index = 0; index < joined.length; index += 1) hash = ((hash * 33) ^ joined.charCodeAt(index)) >>> 0;
      const signature = `${ids.length}:${hash.toString(16)}`;
      if (signature === catalogSignature) return false;
      const first = !catalogSignature;
      catalogSignature = signature;
      revision += 1;
      // The very first catalog of an install is not a change.
      return !first;
    },

    snapshot() {
      return { version: GATEWAY_MODEL_CONTEXT_VERSION, catalogSignature, entries: { ...entries } };
    },

    restore(data) {
      if (!isPlainObject(data) || data.version !== GATEWAY_MODEL_CONTEXT_VERSION || !isPlainObject(data.entries)) return false;
      const next = {};
      for (const [key, value] of Object.entries(data.entries)) {
        if (!isPlainObject(value) || !key.includes('::')) continue;
        const tokens = positiveTokens(value.tokens);
        const at = Number(value.at);
        if (!tokens || !Number.isFinite(at)) continue;
        next[key] = { tokens, source: GATEWAY_CONTEXT_SOURCES.includes(value.source) ? value.source : 'session-usage', at };
      }
      // Readings taken while storage was answering win over the saved copy.
      entries = { ...next, ...entries };
      if (!catalogSignature && typeof data.catalogSignature === 'string') catalogSignature = data.catalogSignature.slice(0, 64);
      prune();
      revision += 1;
      return true;
    },

    clear() {
      entries = {};
      catalogSignature = '';
      revision += 1;
    },
  };
}

// The panel's one store. common.mjs reads it when a model row's window is resolved.
export const gatewayModelContext = createGatewayModelContext();

export function gatewayContextForModel(model = {}) {
  return gatewayModelContext.lookup(model);
}

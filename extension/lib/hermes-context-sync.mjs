import bundledRegistry from './hermes-context-registry-data.mjs';
import { DISPLAY_CONTEXT_ALIASES } from './hermes-context-windows.mjs';

export const HERMES_CONTEXT_SOURCE_URL = 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/model_metadata.py';
export const HERMES_CONTEXT_CACHE_KEY = 'hermesBrowserContextRegistry';
const TTL_MS = 6 * 60 * 60 * 1000;
let registry = bundledRegistry;
let lastAttempt = 0;
let pending = null;

// Parse literal metadata only. Never evaluate or execute downloaded Python.
function assignment(source, name, open, close) {
  const start = new RegExp(`^${name}(?:\\s*:[^=\\n]+)?\\s*=\\s*${open}`, 'm').exec(source);
  if (!start) throw new Error(`Missing Hermes metadata: ${name}`);
  const rest = source.slice(start.index + start[0].length);
  const end = rest.indexOf(close);
  if (end < 0) throw new Error(`Invalid Hermes metadata: ${name}`);
  return rest.slice(0, end).replace(/#[^\n]*/g, '');
}

function numericTable(source, name) {
  const body = assignment(source, name, '\\{', '}');
  const result = {};
  const entry = /["']([^"'\n]+)["']\s*:\s*(\d[\d_]*)\s*,?/g;
  let match;
  while ((match = entry.exec(body))) {
    const value = Number(match[2].replaceAll('_', ''));
    if (!(value > 0 && value <= 100_000_000) || ['__proto__', 'constructor', 'prototype'].includes(match[1])) throw new Error('Invalid context table entry');
    result[match[1]] = value;
  }
  if (body.replace(entry, '').trim()) throw new Error(`Nonliteral context table: ${name}`);
  return result;
}

export function parseHermesContextRegistry(source) {
  if (typeof source !== 'string' || source.length > 1_000_000) throw new Error('Invalid Hermes metadata source');
  const defaults = numericTable(source, 'DEFAULT_CONTEXT_LENGTHS');
  const codex = numericTable(source, '_CODEX_OAUTH_CONTEXT_FALLBACK');
  const verifiedPrefixes = numericTable(source, '_CODEX_OAUTH_VERIFIED_ABOVE_ADVERTISED_PREFIXES');
  const verifiedExact = numericTable(source, '_CODEX_OAUTH_VERIFIED_ABOVE_ADVERTISED_EXACT');
  const strings = (body) => [...body.matchAll(/["']([^"'\n]+)["']/g)].map(match => match[1]);
  const snapshotBases = strings(assignment(source, '_CODEX_900K_SNAPSHOT_BASES', '\\(', ')'));
  const eligible = assignment(source, '_CODEX_900K_ELIGIBLE_BASES', 'frozenset\\(\\{', '}');
  const eligibleBases = [...new Set([...snapshotBases, ...strings(eligible)])];
  const suffix = /^CODEX_CONTEXT_VARIANT_SUFFIX\s*=\s*["']([^"']+)["']/m.exec(source)?.[1];
  const fallback = Number(/^CONTEXT_PROBE_TIERS\s*=\s*\[\s*(\d[\d_]*)/m.exec(source)?.[1]?.replaceAll('_', ''));
  if (!Object.keys(defaults).length || !Object.keys(codex).length || suffix !== '-900k' || !(fallback > 0)) throw new Error('Incomplete Hermes context registry');
  return { defaults, codex, verifiedPrefixes, verifiedExact, eligibleBases, snapshotBases, suffix, fallback, source: 'hermes-upstream' };
}

function keySpecificity(key = '') {
  const normalized = String(key).toLowerCase().replace(/[\s_]+/g, '-').replace(/\./g, '-');
  const versioned = /(?:^|-)(?:\d+)(?:-\d+)+$/.test(normalized) || /\d+\.\d+/.test(String(key));
  return (versioned ? 1_000 : 0) + String(key).length;
}

function longest(table, value) {
  const key = Object.keys(table).sort((left, right) => keySpecificity(right) - keySpecificity(left)).find(key => value.includes(key));
  return key ? table[key] : 0;
}

export function contextFromHermesRegistry(model = {}, data = registry) {
  const provider = String(model.provider || model.providerLabel || '').toLowerCase();
  const identity = String(model.rawModelId || model.raw_model_id || model.model || model.id || '').toLowerCase().split('::').pop();
  const bare = identity.split('/').pop().replace(/^chatgpt-/, 'gpt-');
  if (!bare) return 0;
  if (['openai-codex', 'codex'].includes(provider)) {
    const variant = bare.endsWith(data.suffix);
    const base = variant ? bare.slice(0, -data.suffix.length) : bare;
    const eligible = data.eligibleBases.includes(base) || data.snapshotBases.some(key => base.startsWith(key + '-') && /^\d{4}-\d{2}-\d{2}$/.test(base.slice(key.length + 1)));
    const advertised = longest(data.codex, base);
    if (variant && eligible && advertised === 272_000) {
      const bumped = data.verifiedExact[base] || Object.entries(data.verifiedPrefixes).find(([key]) => base === key || base.startsWith(key + '-'))?.[1];
      if (bumped) {
        const ceiling = Number(model.max_context_window || model.maxContextWindow || 0);
        return ceiling > 0 ? Math.min(bumped, ceiling) : bumped;
      }
    }
    return advertised;
  }
  // Legacy display aliases only fill gaps; exact Agent keys win conflicts.
  return longest({ ...DISPLAY_CONTEXT_ALIASES, ...data.defaults }, identity);
}

function validRegistry(value) {
  return value && ['defaults', 'codex', 'verifiedPrefixes', 'verifiedExact'].every(key => value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]) && Object.values(value[key]).every(n => Number.isFinite(n) && n > 0 && n <= 100_000_000))
    && Object.keys(value.defaults).length > 0 && Object.keys(value.codex).length > 0
    && ['eligibleBases', 'snapshotBases'].every(key => Array.isArray(value[key]) && value[key].every(s => typeof s === 'string'))
    && value.suffix === '-900k' && Number.isFinite(value.fallback) && value.fallback > 0;
}

export async function refreshHermesContextRegistry({ storage = null, fetchFn = globalThis.fetch?.bind(globalThis), refresh = false, now = Date.now(), timeoutMs = 3000 } = {}) {
  if (pending) return pending;
  pending = (async () => {
    let cached;
    try { cached = (await storage?.get(HERMES_CONTEXT_CACHE_KEY))?.[HERMES_CONTEXT_CACHE_KEY]; } catch { /* optional cache */ }
    if (validRegistry(cached?.registry)) registry = cached.registry;
    if (!refresh && cached?.savedAt <= now && now - cached.savedAt < TTL_MS) return { ok: true, source: 'cache' };
    if (!refresh && lastAttempt && now - lastAttempt < 60_000) return { ok: true, source: 'fallback' };
    lastAttempt = now;
    try {
      if (typeof fetchFn !== 'function') throw new Error('no-fetch');
      const response = await fetchFn(HERMES_CONTEXT_SOURCE_URL, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`context-source-${response.status}`);
      const next = parseHermesContextRegistry(await response.text());
      registry = next;
      try { await storage?.set({ [HERMES_CONTEXT_CACHE_KEY]: { registry: next, savedAt: now } }); } catch { /* memory fallback retained */ }
      return { ok: true, source: 'hermes-upstream' };
    } catch (error) {
      return { ok: false, source: 'fallback', error: error.message };
    }
  })();
  try { return await pending; } finally { pending = null; }
}

export function resetHermesContextRegistry() {
  registry = bundledRegistry;
  lastAttempt = 0;
  pending = null;
}

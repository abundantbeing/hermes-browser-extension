import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseHermesContextRegistry, HERMES_CONTEXT_SOURCE_URL } from '../extension/lib/hermes-context-sync.mjs';

const REGISTRY_PREFIX = '// Generated from Hermes Agent metadata; do not edit individual models.\nexport default Object.freeze(';
const REGISTRY_SUFFIX = ');\n';

function bundledRegistry(text = '') {
  if (!text.startsWith(REGISTRY_PREFIX) || !text.endsWith(REGISTRY_SUFFIX)) return null;
  try {
    return JSON.parse(text.slice(REGISTRY_PREFIX.length, text.length - REGISTRY_SUFFIX.length));
  } catch {
    return null;
  }
}

// `source` records where this machine read the metadata (a local Hermes Agent checkout or upstream), not
// what the metadata is. When the bundled table already holds the same data from the same source text
// (sourceSha256 included), it is kept as it is: a build elsewhere must not rewrite a tracked file only
// to flip that label.
function withoutSource(registry) {
  const data = { ...registry };
  delete data.source;
  return JSON.stringify(data);
}

function sameRegistryData(left, right) {
  return Boolean(left && right) && withoutSource(left) === withoutSource(right);
}

export async function syncHermesContextWindows({ root = process.cwd(), sourcePath = '', fetchFn = globalThis.fetch, check = false } = {}) {
  const target = path.join(root, 'extension/lib/hermes-context-registry-data.mjs');
  const candidates = [sourcePath, process.env.HERMES_AGENT_SOURCE && path.join(process.env.HERMES_AGENT_SOURCE, 'agent/model_metadata.py'), path.join(process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'), 'hermes-agent/agent/model_metadata.py')].filter(Boolean);
  let source = '';
  let origin = 'hermes-upstream';
  for (const candidate of candidates) {
    try { source = await fs.readFile(candidate, 'utf8'); origin = 'installed-hermes-agent'; break; } catch { /* try next source */ }
  }
  try {
    if (!source) {
      const response = await fetchFn(HERMES_CONTEXT_SOURCE_URL, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Hermes metadata ${response.status}`);
      source = await response.text();
    }
    const registry = { ...parseHermesContextRegistry(source), source: origin, sourceSha256: createHash('sha256').update(source).digest('hex') };
    const text = `${REGISTRY_PREFIX}${JSON.stringify(registry, null, 2)}${REGISTRY_SUFFIX}`;
    const current = await fs.readFile(target, 'utf8').catch(() => '');
    const unchanged = current === text || sameRegistryData(bundledRegistry(current), registry);
    if (check && !unchanged) throw new Error('Bundled Hermes context registry is stale; run npm run sync:contexts');
    if (!check && !unchanged) await fs.writeFile(target, text, 'utf8');
    console.log(`Hermes context registry: ${Object.keys(registry.defaults).length} defaults, ${Object.keys(registry.codex).length} Codex rules (${origin}${unchanged ? ', bundled table unchanged' : ''})`);
    return { ok: true, registry, written: !check && !unchanged };
  } catch (error) {
    if (check) throw error;
    // Offline builds keep the last known-good bundled snapshot, not an empty table.
    const existing = await fs.readFile(target, 'utf8').catch(() => '');
    if (!existing.includes('export default Object.freeze(')) throw error;
    console.warn(`Hermes metadata sync unavailable; keeping bundled registry: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await syncHermesContextWindows({ check: process.argv.includes('--check') });
}

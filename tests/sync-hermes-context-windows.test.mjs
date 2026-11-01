import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncHermesContextWindows } from '../scripts/sync-hermes-context-windows.mjs';

const SOURCE = `
DEFAULT_CONTEXT_LENGTHS = {"future-model": 777000}
_CODEX_OAUTH_CONTEXT_FALLBACK: Dict[str, int] = {"gpt-future": 272000}
_CODEX_OAUTH_VERIFIED_ABOVE_ADVERTISED_PREFIXES: Dict[str, int] = {}
_CODEX_OAUTH_VERIFIED_ABOVE_ADVERTISED_EXACT: Dict[str, int] = {}
_CODEX_900K_SNAPSHOT_BASES = ("gpt-future",)
_CODEX_900K_ELIGIBLE_BASES = frozenset({*_CODEX_900K_SNAPSHOT_BASES})
CODEX_CONTEXT_VARIANT_SUFFIX = "-900k"
CONTEXT_PROBE_TIERS = [256000, 128000]
`;

// A scratch repository with its own HERMES_HOME, so no Hermes install on the machine running the
// tests is ever read: the only sources are the ones each test hands in.
async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-context-sync-'));
  await fs.mkdir(path.join(root, 'extension/lib'), { recursive: true });
  const saved = { HERMES_HOME: process.env.HERMES_HOME, HERMES_AGENT_SOURCE: process.env.HERMES_AGENT_SOURCE };
  process.env.HERMES_HOME = path.join(root, 'no-hermes-home');
  delete process.env.HERMES_AGENT_SOURCE;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const localCheckout = path.join(root, 'model_metadata.py');
  const target = path.join(root, 'extension/lib/hermes-context-registry-data.mjs');
  return { root, localCheckout, target };
}

const upstream = (text) => async () => ({ ok: true, text: async () => text });
const offline = async () => { throw new Error('offline'); };

test('the same Hermes metadata read from a local checkout leaves the upstream-built table untouched', async (t) => {
  const { root, localCheckout, target } = await scratch(t);
  await syncHermesContextWindows({ root, fetchFn: upstream(SOURCE) });
  const bundled = await fs.readFile(target, 'utf8');
  assert.match(bundled, /"source": "hermes-upstream"/);

  await fs.writeFile(localCheckout, SOURCE, 'utf8');
  const result = await syncHermesContextWindows({ root, sourcePath: localCheckout, fetchFn: offline });
  assert.equal(result.ok, true);
  assert.equal(result.written, false);
  assert.equal(await fs.readFile(target, 'utf8'), bundled, 'only the source label differed, so the tracked file is not rewritten');
  await syncHermesContextWindows({ root, sourcePath: localCheckout, fetchFn: offline, check: true });
});

test('the same holds the other way round: an upstream build keeps a table built from a local checkout', async (t) => {
  const { root, localCheckout, target } = await scratch(t);
  await fs.writeFile(localCheckout, SOURCE, 'utf8');
  await syncHermesContextWindows({ root, sourcePath: localCheckout, fetchFn: offline });
  const bundled = await fs.readFile(target, 'utf8');
  assert.match(bundled, /"source": "installed-hermes-agent"/);

  const result = await syncHermesContextWindows({ root, fetchFn: upstream(SOURCE) });
  assert.equal(result.written, false);
  assert.equal(await fs.readFile(target, 'utf8'), bundled);
});

test('different Hermes metadata still rewrites the table, and --check still reports it stale', async (t) => {
  const { root, localCheckout, target } = await scratch(t);
  await syncHermesContextWindows({ root, fetchFn: upstream(SOURCE) });
  const changed = SOURCE.replace('777000', '888000');
  await fs.writeFile(localCheckout, changed, 'utf8');

  await assert.rejects(
    syncHermesContextWindows({ root, sourcePath: localCheckout, fetchFn: offline, check: true }),
    /Bundled Hermes context registry is stale/,
  );
  const result = await syncHermesContextWindows({ root, sourcePath: localCheckout, fetchFn: offline });
  assert.equal(result.written, true);
  const written = await fs.readFile(target, 'utf8');
  assert.match(written, /"future-model": 888000/);
  assert.match(written, /"source": "installed-hermes-agent"/);
});

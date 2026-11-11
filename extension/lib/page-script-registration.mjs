import {
  PAGE_CONTEXT_GUARD_SCRIPT_ID,
  PAGE_CONTEXT_SCRIPT_ID,
  buildRegisteredPageScriptDefinitions,
} from './page-script-host-policy.mjs';

const REGISTERED_PAGE_SCRIPT_IDS = [PAGE_CONTEXT_GUARD_SCRIPT_ID, PAGE_CONTEXT_SCRIPT_ID];

export function createPageScriptRegistrar({
  scriptingApi,
  packaged = true,
} = {}) {
  if (!scriptingApi?.registerContentScripts) {
    return {
      async sync() {
        return { ok: false, reason: 'scripting-unavailable' };
      },
    };
  }

  let syncChain = Promise.resolve();

  const runExclusive = (task) => {
    syncChain = syncChain.then(task, task);
    return syncChain;
  };

  return {
    sync(settings = {}) {
      return runExclusive(async () => {
        const definitions = buildRegisteredPageScriptDefinitions(settings, { packaged });
        try {
          const existing = typeof scriptingApi.getRegisteredContentScripts === 'function'
            ? await scriptingApi.getRegisteredContentScripts({ ids: REGISTERED_PAGE_SCRIPT_IDS })
            : [];
          const existingIds = new Set((existing || []).map((row) => row.id));
          const missing = definitions.filter((def) => !existingIds.has(def.id));
          const present = definitions.filter((def) => existingIds.has(def.id));
          if (missing.length) {
            await scriptingApi.registerContentScripts(missing);
          }
          if (present.length) {
            await scriptingApi.updateContentScripts(present);
          }
          const bundle = definitions.find((def) => def.id === PAGE_CONTEXT_SCRIPT_ID);
          return { ok: true, excludeCount: bundle?.excludeMatches?.length || 0 };
        } catch (error) {
          return { ok: false, reason: error?.message || String(error) };
        }
      });
    },
  };
}

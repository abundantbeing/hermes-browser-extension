import {
  PAGE_CONTEXT_SCRIPT_ID,
  buildRegisteredPageScriptDefinition,
} from './page-script-host-policy.mjs';

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
        const definition = buildRegisteredPageScriptDefinition(settings, { packaged });
        try {
          const existing = typeof scriptingApi.getRegisteredContentScripts === 'function'
            ? await scriptingApi.getRegisteredContentScripts({ ids: [PAGE_CONTEXT_SCRIPT_ID] })
            : [];
          if (existing?.length) {
            await scriptingApi.updateContentScripts([definition]);
          } else {
            await scriptingApi.registerContentScripts([definition]);
          }
          return { ok: true, excludeCount: definition.excludeMatches.length };
        } catch (error) {
          return { ok: false, reason: error?.message || String(error) };
        }
      });
    },
  };
}

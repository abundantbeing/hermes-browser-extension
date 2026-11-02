// The Assist model picker on a page: the models the side panel already verified for this connection (its
// model catalog cache), and the setting a pick saves. The page asks the background, which reads storage; a
// pick is saved only when it names a model from that list.
import {
  MODEL_CATALOG_CACHE_STORAGE_KEY,
  globalModelCatalogCacheKey,
  modelCatalogCacheKey,
  normalizeCachedModelCatalog,
} from './model-discovery.mjs';

export const INLINE_ASSIST_MODELS_REQUEST = 'HERMES_INLINE_ASSIST_MODELS';
export const INLINE_ASSIST_SET_MODEL = 'HERMES_INLINE_ASSIST_SET_MODEL';

const selectable = (model) => model.runtimeSelectable !== false && model.source !== 'sessions' && model.source !== 'observed';

export function assistModelChoices(cache = {}, settings = {}) {
  const scope = { gatewayMode: settings.gatewayMode, gatewayUrl: settings.gatewayUrl };
  const scoped = normalizeCachedModelCatalog(cache?.[modelCatalogCacheKey({ ...scope, profile: settings.activeProfile })]?.models);
  const rows = scoped.length ? scoped : normalizeCachedModelCatalog(cache?.[globalModelCatalogCacheKey(scope)]?.models);
  const seen = new Set();
  const choices = [];
  for (const model of rows) {
    if (!selectable(model) || seen.has(model.id)) continue;
    seen.add(model.id);
    const provider = String(model.provider || model.owner || '').trim();
    choices.push({
      id: String(model.id),
      rawModelId: String(model.rawModelId || model.id),
      provider,
      label: String(model.label || model.name || model.rawModelId || model.id),
      providerLabel: String(model.providerLabel || provider || ''),
    });
  }
  return choices;
}

export function assistModelSettingsFor(choice = {}) {
  return {
    inlineAssistModel: choice.id,
    inlineAssistRawModel: choice.rawModelId || choice.id,
    inlineAssistProvider: choice.provider || '',
  };
}

export function createInlineAssistModelServer({ runtime, storage }) {
  const fromThisExtension = (sender) => sender?.id === runtime?.id && Boolean(sender?.tab);
  async function read() {
    const stored = await storage.get(['hermesBrowserSettings', MODEL_CATALOG_CACHE_STORAGE_KEY]);
    const settings = stored?.hermesBrowserSettings || {};
    return { settings, choices: assistModelChoices(stored?.[MODEL_CATALOG_CACHE_STORAGE_KEY], settings) };
  }
  return {
    handles: (type) => type === INLINE_ASSIST_MODELS_REQUEST || type === INLINE_ASSIST_SET_MODEL,
    async handle(message, sender) {
      if (!fromThisExtension(sender)) return { ok: false, reason: 'Only Hermes Assist on a page can ask for its models.' };
      const { settings, choices } = await read();
      if (message?.type === INLINE_ASSIST_MODELS_REQUEST) {
        return { ok: true, models: choices, selectedId: String(settings.inlineAssistModel || '') };
      }
      const choice = choices.find((item) => item.id === String(message?.id || ''));
      if (!choice) return { ok: false, reason: 'That model is not in the list Hermes verified for this connection.' };
      // Read again right before the write so the rest of the record is as fresh as it can be.
      const latest = (await storage.get('hermesBrowserSettings'))?.hermesBrowserSettings || settings;
      await storage.set({ hermesBrowserSettings: { ...latest, ...assistModelSettingsFor(choice) } });
      return { ok: true, model: choice };
    },
  };
}

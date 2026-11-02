// The Assist model picker on a page: the models the side panel already verified for this connection (its
// model catalog cache). The background only lists them; it never changes settings for a content script, so
// the page saves its own pick from this list, as it saves its effort and route.
import {
  MODEL_CATALOG_CACHE_STORAGE_KEY,
  globalModelCatalogCacheKey,
  modelCatalogCacheKey,
  normalizeCachedModelCatalog,
} from './model-discovery.mjs';

export const INLINE_ASSIST_MODELS_REQUEST = 'HERMES_INLINE_ASSIST_MODELS';

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
  return {
    handles: (type) => type === INLINE_ASSIST_MODELS_REQUEST,
    async handle(message, sender) {
      if (!fromThisExtension(sender)) return { ok: false, reason: 'Only Hermes Assist on a page can ask for its models.' };
      const stored = await storage.get(['hermesBrowserSettings', MODEL_CATALOG_CACHE_STORAGE_KEY]);
      const settings = stored?.hermesBrowserSettings || {};
      return { ok: true, models: assistModelChoices(stored?.[MODEL_CATALOG_CACHE_STORAGE_KEY], settings), selectedId: String(settings.inlineAssistModel || '') };
    },
  };
}

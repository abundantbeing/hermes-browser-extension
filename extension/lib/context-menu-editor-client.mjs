import {
  CONTEXT_MENU_CONFIG_STORAGE_KEY,
  cloneDefaultContextMenuConfig,
  createContextMenuItemId,
  normalizeContextMenuConfig,
} from './context-menu-config.mjs';
import {
  CONTEXT_MENU_CONFIG_GET,
  CONTEXT_MENU_CONFIG_MUTATE,
} from './context-menu-controller.mjs';
import { createContextMenuEditor } from './context-menu-editor.mjs';

export async function mountContextMenuEditor({ chromeApi, root, translate } = {}) {
  if (!chromeApi?.runtime?.sendMessage || !root) return null;
  let startingConfig = cloneDefaultContextMenuConfig();
  try {
    const response = await chromeApi.runtime.sendMessage({ type: CONTEXT_MENU_CONFIG_GET });
    if (response?.ok && response.config) startingConfig = normalizeContextMenuConfig(response.config);
  } catch (error) {
    console.warn('[Hermes Browser] Context-menu editor could not load its config:', error);
  }

  const editor = createContextMenuEditor({
    root,
    config: startingConfig,
    translate,
    createId: () => createContextMenuItemId(),
    mutate: async (mutation) => {
      const response = await chromeApi.runtime.sendMessage({
        type: CONTEXT_MENU_CONFIG_MUTATE,
        mutation,
      });
      if (!response) {
        throw new Error('Reload Hermes Browser from chrome://extensions, then try again. The extension background process is still running an older version.');
      }
      if (!response?.ok || !response.config) {
        throw new Error(response?.reason || response?.error || 'Context-menu settings could not be saved.');
      }
      return response.config;
    },
  });

  const storageChanged = (changes, areaName) => {
    if (areaName && areaName !== 'local') return;
    const next = changes?.[CONTEXT_MENU_CONFIG_STORAGE_KEY]?.newValue;
    if (next) editor.setConfig(next);
  };
  chromeApi.storage?.onChanged?.addListener?.(storageChanged);

  return {
    ...editor,
    destroy() {
      chromeApi.storage?.onChanged?.removeListener?.(storageChanged);
      editor.destroy();
    },
  };
}

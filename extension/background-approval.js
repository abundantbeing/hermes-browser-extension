import { initI18n, t, translateUiText } from './lib/i18n.mjs';
import { applyStoredPanelAppearance, applyStoredPanelTheme } from './lib/apply-stored-appearance.mjs';
import { getBrowserApi } from './lib/browser-api.mjs';
import { createBackgroundApprovalPage } from './lib/background-approval-surface.mjs';

const browserApi = getBrowserApi();
await initI18n();
await applyStoredPanelAppearance(document.documentElement);
await applyStoredPanelTheme(document.documentElement, browserApi, window.matchMedia('(prefers-color-scheme: dark)').matches);

const page = createBackgroundApprovalPage({
  doc: document,
  approvalId: new URLSearchParams(location.search).get('approval') || '',
  t,
  translateText: translateUiText,
  sendMessage: (message) => browserApi.runtime.sendMessage(message),
  closeWindow: () => window.close(),
});
await page.load();
document.getElementById('backgroundApprovalApprove')?.focus();

/**
 * Group turn context formatter.
 *
 * A group member prompt is submitted to that member's hidden session as a plain
 * user turn. To let the Hermes Browser companion plugin (and any other plugin
 * hook keyed on the Browser Context Protocol) see the page a bot is answering
 * about, the member prompt is wrapped into a FULL BCP v2 turn envelope via
 * `serializeBrowserTurnEnvelope`. That reuses the shared sanitization,
 * restriction, redaction, and budget machinery instead of a hand-rolled
 * "untrusted context" block.
 *
 * When the context is disabled the base prompt is returned byte-identical, so a
 * chat-only or consent-denied turn behaves exactly as it did before.
 */
import { serializeBrowserTurnEnvelope } from './browser-context-protocol.mjs';
import { CONTEXT_SCOPE_MODES } from './context-scope.mjs';

export function formatGroupTurnWithBrowserContext(basePrompt, browserContext = null) {
  const base = String(basePrompt ?? '');
  if (!browserContext || browserContext.enabled !== true) return base;
  const contextScope = browserContext.contextScope || { mode: browserContext.scopeMode || CONTEXT_SCOPE_MODES.FOLLOW_ACTIVE };
  return serializeBrowserTurnEnvelope({
    humanInput: base,
    activeTab: browserContext.activeTab || {},
    tabs: Array.isArray(browserContext.tabs) ? browserContext.tabs : [],
    selectedTabs: Array.isArray(browserContext.selectedTabs) ? browserContext.selectedTabs : null,
    pageContext: browserContext.pageContext || {},
    contextScope,
    settings: browserContext.settings || {},
    contextHash: browserContext.contextHash || '',
    contextDelivery: browserContext.contextDelivery || 'full',
  });
}
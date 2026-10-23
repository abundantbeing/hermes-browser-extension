import { isLoopbackGatewayUrl } from './connection-modes.mjs';
import { prepareTabScreenshotAttachment, resolveBotBrowserContext } from './bot-browser-bridge.mjs';
import { MAX_TURN_SCREENSHOTS, MAX_TURN_SCREENSHOT_CHARS } from './screenshot-limits.mjs';

// The single rule for whether a group turn may carry browser context: a scope that
// asks for it AND a loopback gateway. Nothing cached (consent ledger, capability
// record) can widen it; a remote group stays chat-only until a tested route exists.
export function groupBrowserContextAllowed({ scope = { mode: 'chat-only' }, gatewayUrl = '' } = {}) {
  return scope?.mode !== 'chat-only' && isLoopbackGatewayUrl(gatewayUrl);
}


const OMITTED_NOTES = Object.freeze({
  'remote-group': 'Page context was not shared: group chats share page context only over a local Hermes connection.',
  'restricted-url': 'Page context was not shared: this page cannot be shared.',
  'pinned-mismatch': 'Page context was not shared: the pinned tab is not available.',
  'no-tab': 'Page context was not shared: there is no readable page in this window.',
});

// Why a group turn that asked for page context went out without it. The note
// never carries the page URL or title, so it is safe to show and log.
export function describeGroupContextOutcome({ scope = { mode: 'chat-only' }, gatewayUrl = '', browserContext = null } = {}) {
  if (scope?.mode === 'chat-only') return { shared: false, reason: 'chat-only', note: '' };
  if (!isLoopbackGatewayUrl(gatewayUrl)) return { shared: false, reason: 'remote-group', note: OMITTED_NOTES['remote-group'] };
  if (browserContext?.enabled === true) return { shared: true, reason: 'ok', note: '' };
  const reason = Object.hasOwn(OMITTED_NOTES, browserContext?.reason) ? browserContext.reason : 'no-tab';
  return { shared: false, reason, note: OMITTED_NOTES[reason] };
}

export async function prepareBotBrowserTurn({ scope = { mode: 'chat-only' }, settings = {}, gatewayUrl = '', group = false, getContext, attachments = [], isCurrent = () => true } = {}) {
  const shots = attachments.filter((item) => item?.browserTabScreenshot === true);
  const allowed = scope.mode !== 'chat-only' && (!group || groupBrowserContextAllowed({ scope, gatewayUrl }));
  if (!allowed) {
    if (shots.length) throw new Error('Browser context is disabled. Remove the tab screenshot or enable approved context.');
    return { browserContext: resolveBotBrowserContext({ scopeMode: 'chat-only' }), screenshotAttachments: [] };
  }
  if (shots.length > MAX_TURN_SCREENSHOTS) {
    throw new Error(`A turn carries at most ${MAX_TURN_SCREENSHOTS} tab screenshots. Remove some and send again.`);
  }
  if (shots.reduce((sum, item) => sum + String(item.dataUrl || '').length, 0) > MAX_TURN_SCREENSHOT_CHARS) {
    throw new Error('The tab screenshots are too large together. Remove one and send again.');
  }
  const context = await getContext();
  if (!isCurrent()) throw new Error('The browser context or chat changed before this turn could be sent.');
  const browserContext = resolveBotBrowserContext({
    activeTab: context?.activeTab, tabs: context?.tabs || [], pageContext: context?.pageContext,
    contextScope: scope,
    settings: {
      contextDepth: settings.contextDepth || 'normal', includeTabs: settings.includeTabs === true,
      includePageText: settings.includePageText !== false, includeSelectedText: settings.includeSelectedText !== false,
    },
  });
  const screenshotAttachments = shots.map((item) => {
    if (!browserContext.enabled || item.tabId !== context.activeTab?.id || item.tabUrl !== context.activeTab?.url) {
      throw new Error('The tab changed after the screenshot was attached. Remove it and capture the intended page again.');
    }
    const shot = prepareTabScreenshotAttachment(item.dataUrl, { tabId: item.tabId, title: item.detail, filename: item.label || item.name });
    if (!shot) throw new Error('The browser tab screenshot is invalid or too large.');
    return shot;
  });
  return { browserContext, screenshotAttachments };
}

import { isLoopbackGatewayUrl } from './connection-modes.mjs';
import { prepareTabScreenshotAttachment, resolveBotBrowserContext } from './bot-browser-bridge.mjs';

export async function prepareBotBrowserTurn({ scope = { mode: 'chat-only' }, settings = {}, gatewayUrl = '', group = false, getContext, attachments = [], isCurrent = () => true } = {}) {
  const shots = attachments.filter((item) => item?.browserTabScreenshot === true);
  const allowed = scope.mode !== 'chat-only' && (!group || isLoopbackGatewayUrl(gatewayUrl));
  if (!allowed) {
    if (shots.length) throw new Error('Browser context is disabled. Remove the tab screenshot or enable approved context.');
    return { browserContext: resolveBotBrowserContext({ scopeMode: 'chat-only' }), screenshotAttachments: [] };
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

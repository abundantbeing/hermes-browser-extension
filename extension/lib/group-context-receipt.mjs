/**
 * "What Hermes saw" for a group turn: the page, the tab screenshots and the
 * members the turn was addressed to. Display-only: it rides on the user message
 * in the open room, never in the member prompt, the synced projection or any
 * stored transcript. It carries counts and the tab identity, never page text.
 */
import { buildBrowserContextReceipt } from './browser-context-protocol.mjs';

function memberLabel(member) {
  const name = String(member?.name ?? member ?? '').trim();
  const title = String(member?.title ?? '').trim();
  if (!name) return '';
  return title && title !== name ? `${title} (@${name})` : `@${name}`;
}

export function buildGroupContextReceipt({ browserContext = null, screenshots = [], members = [] } = {}) {
  if (!browserContext || browserContext.enabled !== true) return null;
  const shots = Array.isArray(screenshots) ? screenshots : [];
  const receipt = buildBrowserContextReceipt({
    context: {
      contextScope: browserContext.contextScope,
      activeTab: browserContext.activeTab,
      tabs: browserContext.tabs,
      pageContext: browserContext.pageContext,
    },
    attachments: shots.map(() => ({ kind: 'image' })),
    settings: browserContext.settings || {},
    contextHash: '',
    contextDelivery: 'full',
  });
  const names = (Array.isArray(members) ? members : []).map(memberLabel).filter(Boolean);
  if (names.length) receipt.items.push({ label: 'Sent to', value: names.join(', ') });
  return receipt;
}

// The Firefox limits block in Settings > About & Diagnostics: what this browser cannot do or only partly does, read
// from the same capability matrix as guides/firefox.md, worded through the message catalog.
import {
  capabilityEngineOf,
  capabilityLimitsFor,
  capabilityMessageKey,
} from './browser-capability-matrix.mjs';

export function describeBrowserLimits({ product, t } = {}) {
  const engine = capabilityEngineOf(product);
  const limits = engine === 'firefox' ? capabilityLimitsFor(engine) : [];
  if (!limits.length) return { hidden: true, summary: '', rows: [] };
  return {
    hidden: false,
    summary: t('browser_limits.summary', { count: limits.length }),
    rows: limits.map((limit) => ({
      id: limit.id,
      status: limit.status,
      statusLabel: t(`browser_limits.status_${limit.status}`),
      label: t(capabilityMessageKey(limit.id, 'label')),
      reason: t(capabilityMessageKey(limit.id, 'reason')),
      instead: t('browser_limits.instead', { text: t(capabilityMessageKey(limit.id, 'instead')) }),
    })),
  };
}

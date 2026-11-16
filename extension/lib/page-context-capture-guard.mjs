import { isRestrictedUrl } from './browser-context-protocol.mjs';

export function isPageContextCaptureUrlBlocked(url = '', options = {}) {
  return isRestrictedUrl(url, options);
}
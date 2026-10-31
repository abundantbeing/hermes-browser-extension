// Firefox only lets tabs.captureVisibleTab run with the all-sites host permission (an activeTab grant needs a
// toolbar gesture, and a model command is not one). The Firefox build therefore declares <all_urls> as an
// OPTIONAL host permission, never an install-time one, and asks for it only from a click on a control the
// person can see: "Allow screenshots on Firefox" in Settings, or on the strip where Hermes refused a screenshot.
// Chromium takes its screenshots through the debugger and never needs this.

export const FIREFOX_SCREENSHOT_ORIGINS = Object.freeze(['<all_urls>']);

export const SCREENSHOT_PERMISSION_STATES = Object.freeze({
  NOT_APPLICABLE: 'not-applicable',
  GRANTED: 'granted',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
});

export function isFirefoxProduct(product) {
  return product?.id === 'firefox' || product?.engine === 'gecko';
}

function request() {
  return { origins: [...FIREFOX_SCREENSHOT_ORIGINS] };
}

/** Where the permission stands: only Firefox with a permissions API ever needs to ask. */
export async function screenshotPermissionState({ browserApi, product } = {}) {
  if (!isFirefoxProduct(product)) return SCREENSHOT_PERMISSION_STATES.NOT_APPLICABLE;
  if (typeof browserApi?.permissions?.contains !== 'function') return SCREENSHOT_PERMISSION_STATES.NOT_APPLICABLE;
  try {
    return (await browserApi.permissions.contains(request())) === true
      ? SCREENSHOT_PERMISSION_STATES.GRANTED
      : SCREENSHOT_PERMISSION_STATES.MISSING;
  } catch {
    return SCREENSHOT_PERMISSION_STATES.UNKNOWN;
  }
}

/**
 * Ask Firefox for the permission. Call it first thing inside a click handler: Firefox refuses a request that
 * does not come from user input, and any await before it would spend the gesture. Resolves to whether it is held.
 */
export function requestScreenshotPermission(browserApi) {
  if (typeof browserApi?.permissions?.request !== 'function') {
    return Promise.reject(new Error('This browser cannot ask for the screenshot permission.'));
  }
  return Promise.resolve(browserApi.permissions.request(request())).then((granted) => granted === true);
}

/** Take the permission back. Resolves to whether it was removed. */
export function removeScreenshotPermission(browserApi) {
  if (typeof browserApi?.permissions?.remove !== 'function') {
    return Promise.reject(new Error('This browser cannot remove the screenshot permission.'));
  }
  return Promise.resolve(browserApi.permissions.remove(request())).then((removed) => removed === true);
}

/** What the two controls show for a permission state and whether Hermes just refused a screenshot. */
export function screenshotControlView({ state, refused = false } = {}) {
  const applicable = state === SCREENSHOT_PERMISSION_STATES.GRANTED
    || state === SCREENSHOT_PERMISSION_STATES.MISSING
    || state === SCREENSHOT_PERMISSION_STATES.UNKNOWN;
  const granted = state === SCREENSHOT_PERMISSION_STATES.GRANTED;
  return {
    settingsVisible: applicable,
    granted,
    // The refusal strip offers the grant only while it is still missing.
    stripVisible: applicable && !granted && refused === true,
  };
}

/** The permission changed in the browser (granted, or revoked from its own add-on page). */
export function permissionChangeTouchesScreenshots(change) {
  const origins = Array.isArray(change?.origins) ? change.origins : [];
  return origins.some((origin) => FIREFOX_SCREENSHOT_ORIGINS.includes(origin));
}

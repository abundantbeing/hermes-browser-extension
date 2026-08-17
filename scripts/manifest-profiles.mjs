const MANIFEST_TARGETS = Object.freeze({
  CHROMIUM: 'chromium',
  FIREFOX: 'firefox',
  SAFARI_WEBKIT: 'safari-webkit',
});

const MANIFEST_PROFILES = Object.freeze({
  [MANIFEST_TARGETS.CHROMIUM]: Object.freeze({
    id: MANIFEST_TARGETS.CHROMIUM,
    engine: 'chromium',
    packaging: 'mv3-directory',
    backgroundMode: 'service-worker-module',
    panelMode: 'side-panel',
    removedManifestKeys: Object.freeze([]),
    removedPermissions: Object.freeze([]),
    removedOptionalPermissions: Object.freeze([]),
    requiresMacOS: false,
    directBuildSupported: true,
  }),
  [MANIFEST_TARGETS.FIREFOX]: Object.freeze({
    id: MANIFEST_TARGETS.FIREFOX,
    engine: 'gecko',
    packaging: 'mv3-directory',
    backgroundMode: 'background-scripts-module',
    panelMode: 'sidebar-action',
    removedManifestKeys: Object.freeze(['side_panel', 'minimum_chrome_version']),
    removedPermissions: Object.freeze(['debugger', 'offscreen', 'sidePanel']),
    removedOptionalPermissions: Object.freeze(['audioCapture']),
    requiresMacOS: false,
    directBuildSupported: true,
  }),
  [MANIFEST_TARGETS.SAFARI_WEBKIT]: Object.freeze({
    id: MANIFEST_TARGETS.SAFARI_WEBKIT,
    engine: 'webkit',
    packaging: 'xcode-safari-web-extension-converter',
    backgroundMode: 'xcode-converted-web-extension',
    panelMode: 'full-tab-fallback',
    removedManifestKeys: Object.freeze(['side_panel', 'minimum_chrome_version']),
    removedPermissions: Object.freeze(['offscreen', 'sidePanel', 'debugger', 'tabGroups']),
    removedOptionalPermissions: Object.freeze(['audioCapture', 'debugger']),
    requiresMacOS: true,
    directBuildSupported: false,
  }),
});

function manifestAssumptionsFor(target) {
  const profile = MANIFEST_PROFILES[target];
  if (!profile) throw new Error(`Unknown manifest target: ${target}`);
  return profile;
}

export {
  MANIFEST_PROFILES,
  MANIFEST_TARGETS,
  manifestAssumptionsFor,
};

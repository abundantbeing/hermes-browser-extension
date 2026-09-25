// Resolves the Hermes data directory for helper scripts. Hermes supports
// relocating its data dir — and running named profiles — through the
// HERMES_HOME environment variable, and the native-Windows default is
// %LOCALAPPDATA%\hermes rather than %USERPROFILE%\.hermes. Hardcoding
// ~/.hermes makes setup and API-key copy silently fail for those users.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function hermesHomeCandidates({ env = process.env, platform = process.platform, homedir = os.homedir } = {}) {
  const override = String(env.HERMES_HOME || '').trim();
  if (override) return [override];
  const localAppData = String(env.LOCALAPPDATA || '').trim();
  const candidates = [];
  if (platform === 'win32' && localAppData) candidates.push(path.join(localAppData, 'hermes'));
  candidates.push(path.join(homedir(), '.hermes'));
  return candidates;
}

export function resolveHermesHome(options = {}) {
  const candidates = hermesHomeCandidates(options);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- setup tooling: candidates come from HERMES_HOME or the platform default, never untrusted input.
  const exists = options.exists || ((candidate) => fs.existsSync(candidate));
  return candidates.find((candidate) => exists(candidate)) || candidates[0];
}

export function hermesHomePath(...segments) {
  return path.join(resolveHermesHome(), ...segments);
}

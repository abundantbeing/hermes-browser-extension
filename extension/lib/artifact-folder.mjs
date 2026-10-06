import { isLoopbackGatewayUrl } from './connection-modes.mjs';
import { isLocalArtifactPath } from './artifact-actions.mjs';

// The gateway already exposes a safety-checked shell.exec RPC. This command
// opens a file manager directly. No interpreter, inline script, or download.
export function artifactRevealCommand(filePath, { platform = 'win' } = {}) {
  const path = String(filePath || '').trim();
  if (!isLocalArtifactPath(path) || [...path].some((character) => character.charCodeAt(0) < 32) || /^\\\\/.test(path)) {
    throw new Error('Showing a folder requires an absolute file path on this computer.');
  }
  if (platform === 'win') {
    if (!/^[a-z]:[\\/]/i.test(path) || /["%!`$<>|?*]/.test(path) || path.slice(2).includes(':')) {
      throw new Error('Showing a folder requires a safe file path without shell expansion characters.');
    }
    return `start "" explorer.exe /select,"${path.replace(/\//g, '\\')}"`;
  }
  if (!path.startsWith('/') || !['mac', 'linux'].includes(platform)) {
    throw new Error('Showing a folder requires an absolute file path supported on this computer.');
  }
  const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
  return platform === 'mac' ? `open -R ${quote(path)}` : `xdg-open ${quote(path.slice(0, path.lastIndexOf('/')) || '/')}`;
}

export async function revealArtifactOnComputer(filePath, { gatewayUrl = '', getClient, verifyFile, platform = 'win', isCurrent = () => true } = {}) {
  let local = false;
  try {
    const url = new URL(gatewayUrl);
    local = !url.username && !url.password && isLoopbackGatewayUrl(gatewayUrl);
  } catch { /* invalid connections cannot launch a local process */ }
  if (!local) throw new Error('Connect to local Hermes to show the original file\'s folder. Save downloads a copy.');
  const command = artifactRevealCommand(filePath, { platform });
  if (typeof getClient !== 'function') throw new Error('Local Hermes is unavailable for opening the folder.');
  const connection = await getClient();
  const client = connection?.client || connection;
  if (connection?.baseUrl && !isLoopbackGatewayUrl(connection.baseUrl)) {
    throw new Error('Connect to local Hermes to show the original file\'s folder.');
  }
  if (!isCurrent()) throw new Error('The connection changed before the folder could be opened.');
  if (!client?.request) throw new Error('Local Hermes is unavailable for opening the folder.');
  const file = typeof verifyFile === 'function' ? await verifyFile(filePath) : null;
  if (!file?.ok) throw new Error('This file could not be verified. Its folder was not opened and no copy was downloaded.');
  if (!isCurrent()) throw new Error('The connection changed before the folder could be opened.');
  const result = await client.request('shell.exec', { command });
  if (result?.code !== 0) {
    throw new Error(String(result?.stderr || '').trim().slice(0, 500) || 'Hermes could not open the containing folder. No copy was downloaded.');
  }
  return { revealed: true };
}

import os from 'node:os';
import path from 'node:path';

export function chromeExecutableCandidates({
  envPath = process.env.CHROME_PATH,
  home = os.homedir(),
  platform = process.platform,
} = {}) {
  const linuxCandidates = [
    path.join(home, 'opt/chrome-for-testing/chrome-linux64/chrome'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
  const windowsCandidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const macCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  const configuredForWindows = platform === 'win32';
  const configuredForPosix = envPath
    && !/^[a-z]:\\/i.test(envPath)
    && !/^\/mnt\/[a-z]\//i.test(envPath)
    && !/\.exe$/i.test(envPath);
  const configured = envPath && (configuredForWindows || configuredForPosix) ? [envPath] : [];

  if (platform === 'win32') return [...configured, ...windowsCandidates];
  if (platform === 'darwin') return [...configured, ...macCandidates];
  return [...configured, ...linuxCandidates];
}

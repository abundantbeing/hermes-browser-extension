import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version || '').trim();
const addonId = 'hermes-browser-extension@abundantbeing.github.io';
const updateUrl = `https://github.com/abundantbeing/hermes-browser-extension/releases/download/v${version}/hermes-browser-extension-v${version}-firefox.xpi`;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Invalid release version: ${version || '(empty)'}`);
}

const updates = {
  addons: {
    [addonId]: {
      updates: [
        {
          version,
          update_link: updateUrl,
        },
      ],
    },
  },
};

fs.writeFileSync(path.join(root, 'updates.json'), `${JSON.stringify(updates, null, 2)}\n`, 'utf8');
console.log(`Prepared Firefox update manifest for v${version}: ${updateUrl}`);

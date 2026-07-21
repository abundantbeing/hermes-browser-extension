import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const firefoxDist = path.join(dist, 'firefox');
const outDir = path.join(root, 'artifacts');
const stageRoot = path.join(outDir, '.release-stage');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version || '').trim();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid release version: ${version || '(empty)'}`);
  process.exit(1);
}

const artifactNames = Object.freeze({
  chromium: `hermes-browser-extension-v${version}-chromium.tar.gz`,
  firefox: `hermes-browser-extension-v${version}-firefox-preview.tar.gz`,
});
const checksumName = `SHA256SUMS-v${version}.txt`;
const obsoleteCurrentNames = [
  `hermes-browser-extension-v${version}-firefox.tar.gz`,
  'SHA256SUMS.txt',
];

function relativeToRoot(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function copyDir(from, to, { skipNames = new Set() } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || skipNames.has(entry.name)) continue;
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
  }
}

function readManifest(directory, target) {
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`${target} manifest is missing. Run the target build first.`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`${target} manifest version ${manifest.version} does not match package version ${version}.`);
  }
  return manifest;
}

function archiveDirectory(stageDir, outputPath) {
  fs.rmSync(outputPath, { force: true });
  const result = spawnSync(
    'tar',
    ['-czf', relativeToRoot(outputPath), '-C', relativeToRoot(stageDir), '.'],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`tar packaging failed for ${path.basename(outputPath)}`);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fileCount(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += fileCount(itemPath);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function main() {
  if (!fs.existsSync(dist)) throw new Error('dist/ does not exist. Run npm run build first.');
  if (!fs.existsSync(firefoxDist)) throw new Error('dist/firefox/ does not exist. Run npm run build:firefox first.');

  const chromiumManifest = readManifest(dist, 'Chromium');
  const firefoxManifest = readManifest(firefoxDist, 'Firefox');
  if (chromiumManifest.browser_specific_settings?.gecko) {
    throw new Error('Chromium manifest unexpectedly contains Firefox browser_specific_settings.');
  }
  if (!firefoxManifest.browser_specific_settings?.gecko?.id) {
    throw new Error('Firefox manifest is missing browser_specific_settings.gecko.id.');
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(stageRoot, { recursive: true, force: true });
  for (const obsoleteName of obsoleteCurrentNames) {
    fs.rmSync(path.join(outDir, obsoleteName), { force: true });
  }
  const stages = {
    chromium: path.join(stageRoot, 'chromium'),
    firefox: path.join(stageRoot, 'firefox'),
  };

  // Chromium must not contain the nested Firefox build tree.
  copyDir(dist, stages.chromium, { skipNames: new Set(['firefox']) });
  copyDir(firefoxDist, stages.firefox);

  const outputs = {
    chromium: path.join(outDir, artifactNames.chromium),
    firefox: path.join(outDir, artifactNames.firefox),
  };
  archiveDirectory(stages.chromium, outputs.chromium);
  archiveDirectory(stages.firefox, outputs.firefox);

  const buildInfoPath = path.join(dist, 'build-info.json');
  const buildInfo = fs.existsSync(buildInfoPath)
    ? JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
    : {};
  const artifacts = Object.entries(outputs).map(([target, filePath]) => ({
    target,
    file: path.basename(filePath),
    sha256: sha256(filePath),
    bytes: fs.statSync(filePath).size,
    files: fileCount(stages[target]),
  }));

  fs.writeFileSync(
    path.join(outDir, checksumName),
    `${artifacts.map((entry) => `${entry.sha256}  ${entry.file}`).join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(outDir, 'release-manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      name: packageJson.name,
      version,
      commit: String(buildInfo.commit || ''),
      dirty: Boolean(buildInfo.dirty),
      generatedAt: new Date().toISOString(),
      artifacts,
    }, null, 2)}\n`,
    'utf8',
  );

  fs.rmSync(stageRoot, { recursive: true, force: true });
  for (const artifact of artifacts) {
    console.log(`Packaged ${artifact.target}: ${path.join(outDir, artifact.file)}`);
  }
  console.log(`Checksums: ${path.join(outDir, checksumName)}`);
  console.log(`Release manifest: ${path.join(outDir, 'release-manifest.json')}`);
}

try {
  main();
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}

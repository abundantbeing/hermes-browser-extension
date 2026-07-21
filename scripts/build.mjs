import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeContentExtractorRuntime } from './build-content-runtime.mjs';

const root = process.cwd();
const src = path.join(root, 'extension');
const dest = path.join(root, 'dist');
const buildInfoFileName = 'build-info.json';

await writeContentExtractorRuntime({ rootDir: root });

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, targetPath);
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function gitOutput(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitBlobSha(filePath, relativePath) {
  const repositoryPath = path.posix.join('extension', relativePath);
  const filteredSha = gitOutput(['hash-object', '--filters', `--path=${repositoryPath}`, filePath]);
  if (/^[0-9a-f]{40}$/i.test(filteredSha)) return filteredSha.toLowerCase();
  const content = fs.readFileSync(filePath);
  return createHash('sha1')
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

function collectSourceBlobs(directory = src, relativeDirectory = '') {
  const rows = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name);
    if (relativePath === buildInfoFileName) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...Object.entries(collectSourceBlobs(absolutePath, relativePath)));
    else if (entry.isFile()) rows.push([relativePath, gitBlobSha(absolutePath, relativePath)]);
  }
  return Object.fromEntries(rows.sort(([left], [right]) => left.localeCompare(right)));
}

function buildInfo() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const commit = gitOutput(['rev-parse', 'HEAD']);
  const branch = gitOutput(['branch', '--show-current']);
  const status = gitOutput(['status', '--short', '--', 'extension', 'package.json']);
  return {
    name: packageJson.name,
    version: packageJson.version,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : '',
    branch,
    dirty: Boolean(status),
    sourceBlobs: collectSourceBlobs(),
    builtAt: new Date().toISOString(),
    repository: packageJson.repository?.url || '',
  };
}

const infoJson = `${JSON.stringify(buildInfo(), null, 2)}\n`;
fs.writeFileSync(path.join(root, buildInfoFileName), infoJson);
fs.writeFileSync(path.join(src, buildInfoFileName), infoJson);
fs.rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);
fs.writeFileSync(path.join(dest, buildInfoFileName), infoJson);
console.log(`Built unpacked extension: ${dest}`);
console.log(`Stamped build metadata: ${buildInfoFileName}, extension/${buildInfoFileName}, dist/${buildInfoFileName}`);

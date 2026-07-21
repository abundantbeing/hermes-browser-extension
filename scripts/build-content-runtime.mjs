import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRootDir = path.resolve(path.dirname(scriptPath), '..');
const generatedRelativePath = 'extension/content-extractor.js';
const AUTHORED_MODULES = Object.freeze([
  {
    path: 'extension/lib/content-extraction-core.mjs',
    runtimeName: 'hermesContentExtractorRuntime',
    globalName: 'HermesContentExtractor',
    apiName: 'CONTENT_EXTRACTION_API',
  },
  {
    path: 'extension/lib/appearance-themes.mjs',
    runtimeName: 'hermesAppearanceRuntime',
    globalName: 'HermesAppearance',
    apiName: 'APPEARANCE_RUNTIME_API',
  },
  {
    path: 'extension/lib/site-adapters.mjs',
    runtimeName: 'hermesSiteAdapterRuntime',
    globalName: 'HermesSiteAdapters',
    apiName: 'SITE_ADAPTER_API',
  },
  {
    path: 'extension/lib/inline-draft-policy.mjs',
    runtimeName: 'hermesInlineDraftRuntime',
    globalName: 'HermesInlineDraft',
    apiName: 'INLINE_DRAFT_API',
  },
]);

function classicModuleBody(source, authoredPath) {
  if (/^\s*import\s/m.test(source)) {
    throw new Error(`${authoredPath} must remain import-free for the zero-dependency classic runtime.`);
  }
  if (/^\s*export\s+default\s/m.test(source)) {
    throw new Error(`${authoredPath} may use named exports only.`);
  }
  const body = source.replace(/^export\s+/gm, '');
  if (/^\s*(?:import|export)\s/m.test(body)) {
    throw new Error(`${authoredPath} contains an unsupported module statement.`);
  }
  return body.trim();
}

function renderClassicModule(module, source) {
  const sourceHash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const body = classicModuleBody(source, module.path);
  return `/* ${module.path} · SHA-256 ${sourceHash} */\n(function ${module.runtimeName}(hermesGlobal) {\n  'use strict';\n\n${body}\n\n  hermesGlobal.${module.globalName} = ${module.apiName};\n})(globalThis);`;
}

export async function renderContentExtractorRuntime({ rootDir = defaultRootDir } = {}) {
  const rendered = [];
  for (const module of AUTHORED_MODULES) {
    const sourcePath = path.join(rootDir, ...module.path.split('/'));
    const source = await readFile(sourcePath, 'utf8');
    rendered.push(renderClassicModule(module, source));
  }
  const sources = AUTHORED_MODULES.map((module) => module.path).join(', ');
  return `/* Generated from ${sources}. Do not edit directly. */\n${rendered.join('\n\n')}\n`;
}

export async function writeContentExtractorRuntime({
  rootDir = defaultRootDir,
  destination = path.join(rootDir, ...generatedRelativePath.split('/')),
} = {}) {
  const rendered = await renderContentExtractorRuntime({ rootDir });
  await writeFile(destination, rendered, 'utf8');
  return destination;
}

export async function checkContentExtractorRuntime({
  rootDir = defaultRootDir,
  destination = path.join(rootDir, ...generatedRelativePath.split('/')),
} = {}) {
  const expected = await renderContentExtractorRuntime({ rootDir });
  let actual = '';
  try {
    actual = await readFile(destination, 'utf8');
  } catch {
    return false;
  }
  return actual === expected;
}

async function main() {
  if (process.argv.includes('--check')) {
    if (!await checkContentExtractorRuntime()) {
      console.error(`[content-runtime] ${generatedRelativePath} is missing or stale. Run: npm run build:content-runtime`);
      process.exitCode = 1;
      return;
    }
    console.log(`[content-runtime] ${generatedRelativePath} is current.`);
    return;
  }
  const destination = await writeContentExtractorRuntime();
  console.log(`[content-runtime] wrote ${path.relative(defaultRootDir, destination).replaceAll('\\', '/')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

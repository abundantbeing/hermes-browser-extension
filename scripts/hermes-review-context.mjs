import path from 'node:path';

export function fileCategory(filename) {
  if (/(^|\/)_locales\//.test(filename) && filename.endsWith('.json')) return 'locale';
  if (/^(dist|artifacts)\//.test(filename) || filename === 'extension/content-extractor.js' || /hermes-context-registry-data\.mjs$/.test(filename) || /(?:package-lock|npm-shrinkwrap)\.json$/.test(filename)) return 'generated';
  if (/\.(png|jpe?g|webp|gif|ico|woff2?|zip|mp[34])$/i.test(filename)) return 'asset';
  if (/^tests\//.test(filename)) return 'test';
  if (/\.md$/i.test(filename) || /^(guides|docs)\//.test(filename)) return 'docs';
  return 'source';
}

export function derivePullLabels(target, diff = '') {
  const files = Array.isArray(target.files) ? target.files : [...String(diff).matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)].map((m) => ({ filename: m[2] }));
  const substantive = files.filter((f) => !['locale', 'generated', 'asset'].includes(fileCategory(f.filename)));
  let type = 'type/chore';
  if (substantive.length && substantive.every((f) => fileCategory(f.filename) === 'docs')) type = 'type/docs';
  else if (substantive.length && substantive.every((f) => fileCategory(f.filename) === 'test')) type = 'type/test';
  else if (/^fix(?:\(|:|!)/i.test(target.title || '')) type = 'type/bug';
  else if (/^feat(?:\(|:|!)/i.test(target.title || '')) type = 'type/feature';
  const scores = new Map();
  for (const file of substantive) {
    const f = file.filename;
    let comp = '';
    if (fileCategory(f) === 'docs') comp = 'comp/docs';
    else if (fileCategory(f) === 'test') continue;
    else if (/browser-control|controller-|tab-leases/.test(f)) comp = 'comp/browser-control';
    else if (/sidepanel\.(js|css|html)$|app\.(js|css|html)$/.test(f)) comp = 'comp/sidepanel';
    else if (/background\.js$/.test(f)) comp = 'comp/background';
    else if (/model|provider|reasoning/.test(f)) comp = 'comp/models';
    else if (/session|history/.test(f)) comp = 'comp/sessions';
    else if (/voice|wake-|dictation/.test(f)) comp = 'comp/voice';
    else if (/settings|setup|pairing/.test(f)) comp = 'comp/settings';
    else if (/content|context|extract/.test(f)) comp = 'comp/context-capture';
    else if (/gateway|transport/.test(f)) comp = 'comp/gateway';
    else if (/manifest|^scripts\/build|^package\.json$/.test(f)) comp = 'comp/build';
    if (comp) scores.set(comp, (scores.get(comp) || 0) + Math.max(1, Number(file.changes) || 1));
  }
  return [type, ...[...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([name]) => name)].sort();
}

function patchRecords(patch = '') {
  const records = [];
  let right = 0, left = 0, active = false;
  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { left = Number(hunk[1]); right = Number(hunk[2]); active = true; records.push({ kind: 'header', raw }); continue; }
    if (!active || raw.startsWith('\\') || !['+', '-', ' '].includes(raw[0])) { records.push({ kind: 'header', raw }); continue; }
    if (raw[0] === '+') records.push({ kind: 'added', raw, line: right++, text: raw.slice(1).replace(/\r$/, '') });
    else if (raw[0] === '-') records.push({ kind: 'removed', raw, line: left++, text: raw.slice(1).replace(/\r$/, '') });
    else { left += 1; records.push({ kind: 'context', raw, line: right++, text: raw.slice(1).replace(/\r$/, '') }); }
  }
  return records;
}

export function addedPatchLines(patch = '') {
  return new Map(patchRecords(patch).filter((r) => r.kind === 'added').map((r) => [r.line, r.text]));
}

export function removedPatchLines(patch = '') {
  return new Map(patchRecords(patch).filter((r) => r.kind === 'removed').map((r) => [r.line, r.text]));
}

export function countPatchChanges(patch = '') {
  const records = patchRecords(patch);
  return { additions: records.filter((r) => r.kind === 'added').length, deletions: records.filter((r) => r.kind === 'removed').length };
}

function numberedPatch(patch) {
  return patchRecords(patch).map((r) => r.kind === 'header' ? r.raw : `${r.kind === 'removed' ? 'L' : 'R'}${r.line} | ${r.raw}`).join('\n');
}

export function packReviewFiles(files, { maxChars = 150000 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1000) throw new Error('Invalid review packet budget');
  const manifest = files.map((f) => ({ path: f.filename, status: f.status || 'modified', additions: f.additions || 0, deletions: f.deletions || 0, category: fileCategory(f.filename) }));
  const coverage = { totalFiles: files.length, sourceFiles: 0, localesSummarized: 0, generatedSkipped: 0, assetsSkipped: 0, omitted: [], complete: false };
  const packets = [];
  let packet = '';
  const flush = () => { if (packet) packets.push(packet); packet = ''; };
  const order = { source: 0, test: 1, docs: 2, locale: 3, generated: 4, asset: 5 };
  for (const file of [...files].sort((a, b) => order[fileCategory(a.filename)] - order[fileCategory(b.filename)] || a.filename.localeCompare(b.filename))) {
    const category = fileCategory(file.filename);
    if (category === 'generated') { coverage.generatedSkipped += 1; continue; }
    if (category === 'asset') { coverage.assetsSkipped += 1; continue; }
    if (category === 'locale') { coverage.localesSummarized += 1; continue; }
    coverage.sourceFiles += 1;
    if (!file.patch?.trim()) { coverage.omitted.push(file.filename); continue; }
    const header = `\nFILE ${JSON.stringify(file.filename)} (${category}, ${file.status || 'modified'}). R = head line, L = base line.\n`;
    const lines = numberedPatch(file.patch).split('\n');
    let fragment = header;
    for (const line of lines) {
      if (line.length + header.length + 1 > maxChars) { coverage.omitted.push(file.filename); continue; }
      if (fragment.length + line.length + 1 > maxChars) {
        flush(); packets.push(fragment); fragment = header + '[continued, line numbers preserved]\n';
      }
      fragment += `${line}\n`;
    }
    if (packet.length + fragment.length > maxChars) flush();
    packet += fragment;
  }
  flush();
  coverage.omitted = [...new Set(coverage.omitted)];
  coverage.complete = coverage.omitted.length === 0;
  return { manifest, coverage, packets };
}

export function localeKeySummary(files) {
  return files.filter((f) => fileCategory(f.filename) === 'locale').map((f) => ({ path: f.filename,
    addedKeys: [...new Set([...String(f.patch || '').matchAll(/^\+\s*["']([^"']+)["']\s*:/gm)].map((m) => m[1]))],
    removedKeys: [...new Set([...String(f.patch || '').matchAll(/^-\s*["']([^"']+)["']\s*:/gm)].map((m) => m[1]))],
    patchAvailable: Boolean(f.patch),
  }));
}

export function validateFindings(findings, files) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const f of Array.isArray(findings) ? findings : []) {
    const file = files.find((entry) => entry.filename === f?.path);
    const added = file ? addedPatchLines(file.patch).get(f.line) : null;
    const removed = file ? removedPatchLines(file.patch).get(f.line) : null;
    const evidence = typeof f?.evidence === 'string' ? f.evidence.trim() : '';
    // A line can be both added and removed in different hunks; evidence decides
    // which side the finding describes. Added lines win ties.
    const anchor = added !== null && added !== undefined && added.trim() === evidence ? 'added'
      : removed !== null && removed !== undefined && removed.trim() === evidence ? 'removed'
      : added !== null && added !== undefined ? 'added' : 'removed';
    const code = anchor === 'added' ? added : removed;
    const key = `${f?.path}:${f?.line}:${f?.title}`;
    const valid = file && ['P0', 'P1', 'P2'].includes(f.severity) && Number.isSafeInteger(f.line) && f.line > 0
      && typeof f.evidence === 'string' && f.evidence.trim().length > 0 && code?.trim() === f.evidence.trim()
      && typeof f.title === 'string' && f.title.length >= 8 && f.title.length <= 180
      && typeof f.body === 'string' && f.body.length >= 35 && f.body.length <= 4000 && !seen.has(key);
    if (!valid) { rejected.push(f); continue; }
    seen.add(key);
    // A finding without a remedy is a question, not a review. The remediation
    // pass fills it in; a finding that still has no fix is published as-is and
    // marked, never silently upgraded into a defect claim.
    const fix = typeof f.fix === 'string' && f.fix.trim().length >= 20 ? f.fix.trim() : null;
    const verification = typeof f.verification === 'string' && f.verification.trim().length >= 10 ? f.verification.trim() : null;
    const patch = typeof f.patch === 'string' && f.patch.trim().length >= 8 ? f.patch.trim() : null;
    accepted.push({ path: f.path, line: f.line, severity: f.severity, title: f.title, body: f.body, evidence: f.evidence, anchor, fix, verification, patch });
  }
  return { accepted: accepted.sort((a, b) => a.severity.localeCompare(b.severity)), rejected };
}

export function relatedImportPaths(filename, source, inventory) {
  const available = new Set(inventory);
  return [...new Set([...source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(filename), m[1]))))]
    .filter((f) => available.has(f) && !f.startsWith('../') && fileCategory(f) === 'source');
}

#!/usr/bin/env node
import fs from 'node:fs';
import { collectPullReview, generatePullReview, REVIEW_REPO, saveReviewArtifact } from './hermes-review-pipeline.mjs';

// This entrypoint has no publication path. It never changes GitHub or the live ledger.
const args = process.argv.slice(2);
const number = Number(args[0]);
const directory = args[1];
if (!Number.isSafeInteger(number) || number < 1 || !directory) throw new Error('Usage: review-preview.mjs <PR number> <absolute output directory> [--collect-only]');
const bundle = await collectPullReview({ repo: REVIEW_REPO, number, token: process.env.GITHUB_TOKEN });
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(`${directory}/${number}-bundle.json`, JSON.stringify(bundle, null, 2));
if (args.includes('--collect-only')) {
  console.log(JSON.stringify({ number, head: bundle.headSha, files: bundle.files.length, omitted: bundle.files.filter((f) => !f.patch && f.patchIncomplete).map((f) => f.filename) }));
} else {
  const result = await generatePullReview(bundle, process.env);
  saveReviewArtifact(directory, number, bundle, result);
  console.log(JSON.stringify({ number, head: bundle.headSha, files: bundle.files.length, coverage: result.coverage, findings: result.findings.length, calls: result.calls, markdown: `${directory}/${number}-${bundle.headSha}.md` }));
}

# Automated review pipeline

The local review watcher polls open Hermes Browser Extension PRs and issues. It does not require GitHub Actions. It is restricted to `abundantbeing/hermes-browser-extension` and never approves or merges a PR.

## Trust and model boundaries

The writer makes a single completion at a time through Hermes' provider clients. It has no agent loop, tools, MCP servers, long-term memory, GitHub client, or execution access. Repository files and discussion are untrusted input, not instructions.

The local wrapper explicitly selects GPT-6.1-SOL-900K through OpenAI Codex with `xhigh` reasoning. Its only fallback is `deepseek/deepseek-v4.1-flash-1017` through Nous Portal. These routes belong to this job; changing the interactive chat model does not change them. The route is recorded in internal execution metadata and logs, and is not printed in the published review.

Provider credentials remain in Hermes' existing credential stores. Never put them in the repository, cron prompt, review comments, or preview artifacts.

The GitHub credential is verified against the API before use. An inherited `GITHUB_TOKEN` that no longer authenticates is replaced by the Git Credential Manager credential, and the run fails with a clear error when neither works. A stale token must never turn into a silent no-op or a published review against the wrong identity.

## What a PR review includes

1. Freeze the PR's head and base commits. Collect every changed file through pagination and check the count against GitHub's declared total.
2. Prefer the full unified diff. Detect unavailable or incomplete per-file patches rather than silently treating them as complete.
3. Separate source, tests and docs from generated files, lockfiles, binary assets and locale catalogs. Pack substantive patches into bounded, line-numbered packets. Preserve all packet fragments, including the end of large files.
4. Read surrounding code and a bounded set of related imports from the immutable head. Collect existing discussion, inline findings, check runs, commit statuses and mergeability.
5. Analyze each packet, then synthesize across packets and challenge candidate findings. No contributor code or tests execute on the operator's machine.
6. Accept a finding only when its path, added head line and verbatim code evidence match the actual diff. Keep findings at P0–P2. Do not fill space with speculative hardening or style preferences.
6a. Treat a changed constant, source label, guard or helper as a contract change. Build a consumer index from the whole head so a caller that still assumes the old behavior is visible even when the caller is not in the PR. A consumer that no longer recognizes a case it used to recognize is a P2 regression, not a suggestion.
6b. Every finding must carry a fix, a verification, and, where possible, a proposed change. A finding that survives validation without a fix gets one dedicated remediation pass. A diagnosis the author cannot act on is not a review.
7. Recheck the head, base, open state and draft flag before publication. Update the existing owned summary comment and post deduplicated, commit-bound inline findings. Read every write back before marking the target complete.
8. Apply labels after verified publication. Use one type and at most two path-derived components. Remove only labels recorded as pipeline-owned; preserve manually applied labels.

Each review opens with an at-a-glance panel: counted severity bars, suggestion count, source coverage and code-chunk count. Every count shares one bar scale, and the panel states what the scale means, that a dot means zero, and that the coverage rows partition the changed files while the indented file-type rows are a second breakdown of the same total. Severity levels are defined inline. It then carries blocking findings, a separate non-blocking Suggestions section, immutable code links, real diff excerpts, verification evidence, and a collapsible changed-file inventory. Suggestions are useful changes, not defects; they are capped at five and never padded. It does not turn missing CI into a defect or call author checkboxes verified execution.

Long lines in a code excerpt are clipped with a visible marker and a pointer to the linked line, so a code block never runs past the comment column.

Each finding is structured rather than a paragraph. `What happens` states the trigger, the failing flow and the consequence. `Fix` names the exact function, guard or condition to change and the resulting behavior. `How to verify` names the check that fails before the fix and passes after it. `Proposed change` shows the diff when one can be written, and is explicitly a proposal, not a verified patch. The inline thread carries the same four parts, so the author can act without scrolling back to the summary.

The review does not disclose the model or provider that served it. The route stays in internal execution metadata and logs.

When this pass confirms no defect but another reviewer has open findings on the same commit, the review says so and links them. A clean result next to an unread third-party finding is a misleading result. When another reviewer's finding was raised against an earlier commit in the same PR, the review says that instead of restating it as an open issue, and the synthesis pass is required to read the current head before claiming it.

Findings may anchor on an added head line or on a removed base line. A removed-line finding appears in the summary with base-side evidence, because a head-side inline comment cannot carry evidence that no longer exists.

## Per-review illustration

Each review also generates one campaign illustration derived from what the contribution changes: the change kind selects the metaphor (feature, fix, docs, tests, refactor, performance, localization), the PR or issue number and head select the pose and environment, and the Hermes Browser character, palette and typography stay constant. The image sits above the evidence with no caption.

Art is decorative and fail-open: `HERMES_REVIEW_ART=0` disables it, and any provider or upload failure publishes the review without an image. `HERMES_REVIEW_ART_BACKEND` selects the image backend and `HERMES_REVIEW_ART_DIR` the local artifact directory.

A host can accept an upload and still store a truncated body, which renders as a broken image. Every hosted URL is read back and byte-compared with the local file before it is used; a short read is retried with re-encoded bytes, then with the next host. A cached art URL is re-verified on reuse and dropped when it no longer serves its recorded length.

## Coverage limits

Locale catalogs are summarized by changed keys; translation semantics are not reviewed. Generated bundles, lockfiles and binary assets are listed but not analyzed. Related source is bounded and may be excerpted. Visual appearance, cross-browser operation, live gateway behaviour and passing tests require separate execution evidence.

Unavailable source patches produce an explicit incomplete review, not merge clearance. Exceeding the configured packet limit fails before posting instead of dropping remaining files.

## Deduplication and recovery

- A token-owned process lock prevents overlapping watcher/event runs. Stale-owner recovery is serialized. An unreadable state file or abandoned recovery guard fails closed rather than allowing overlap.
- The ledger is atomically saved after each completed target or follow-up.
- A failed target receives a retry delay and cannot keep unattempted targets behind it forever.
- Review artifacts and completed packet responses use atomic writes. Malformed disposable artifacts are quarantined and regenerated; the deduplication ledger is never silently reset.
- Inline threads use the immutable head, path and line as their identity. Distinct findings on the same line share one thread; rewording updates it rather than posting a duplicate.
- Label ownership intent is journaled before external writes, including issue labels, so a failed readback does not lose ownership on retry. Pre-existing human labels stay human-owned.
- Polling skips drafts. Head, base, title and body changes affect eligibility. Existing reviews receive a base-aware baseline during migration without mass-posting historical reviews. Changing only the pipeline version does not trigger a review.
- Follow-ups answer new human comments. Bot comments, including Greptile findings, are context only and never trigger a reply loop.
- Existing current-head findings from another reviewer are considered during synthesis. Sharing a line is not sufficient to declare two findings duplicates.
- Marker text alone is not ownership. Publication checks the authenticated comment author before updating a summary or accepting an inline deduplication marker.

## Operator verification

The installed Python wrapper supports:

- `--check`: validate local paths and route configuration without GitHub or model calls.
- `--dry-run`: inspect pending targets without model calls, external writes or ledger changes.
- `--preview <PR number> --output <directory>`: generate a private review and evidence bundle. This path cannot publish to GitHub.

The repository's `scripts/hermes-review-preview.mjs` is also a read-only preview entrypoint. It expects the wrapper's runtime/provider environment and an in-memory `GITHUB_TOKEN`. Do not save credentials in preview files.

Focused regression commands:

```sh
node --test tests/review-agent.test.mjs tests/review-stream.test.mjs tests/review-watch.test.mjs tests/review-pipeline.test.mjs tests/review-publish.test.mjs tests/review-queue.test.mjs tests/review-reliability.test.mjs
python -m unittest discover -s tests/pytools -p test_review_writer.py -v
```

Keep private previews separate from published comments. Do not mass-refresh historical PRs as a side effect of an upgrade.

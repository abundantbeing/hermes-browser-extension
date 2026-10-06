import vm from 'node:vm';

// Extracted orchestration tests must load their real lifecycle dependencies.
// No-op replacements would conceal abort/composer ownership regressions.
export function installGroupLifecycleHarness(context, source) {
  context.backgroundGroupTurn ??= null;
  context.activeComposerLease ??= null;
  context.groupComposerSerial ??= 0;
  if (!vm.isContext(context)) vm.createContext(context);
  for (const name of ['claimGroupComposer', 'releaseGroupComposer', 'abortAttachedGroupTurn', 'abortBackgroundGroupTurn', 'backgroundTurnFor', 'reattachBackgroundGroupTurn', 'commitDetachedGroupTranscript']) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing group lifecycle dependency: ${name}`);
    const end = source.indexOf('\nfunction ', start + 10);
    vm.runInContext(source.slice(start, end < 0 ? source.length : end), context);
  }
}

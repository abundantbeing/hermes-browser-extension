import vm from 'node:vm';
import { settleGroupComposer } from '../../extension/lib/group-composer-settle.mjs';
import { describeGroupContextOutcome, groupBrowserContextAllowed } from '../../extension/lib/bot-browser-turn.mjs';

// Extracted orchestration tests must load their real lifecycle dependencies.
// No-op replacements would conceal abort/composer ownership regressions.
export function installGroupLifecycleHarness(context, source) {
  context.backgroundGroupTurn ??= null;
  context.activeComposerLease ??= null;
  context.groupComposerSerial ??= 0;
  // Composer and context-outcome collaborators of the group send: the real pure modules, with
  // inert DOM/draft hooks unless the test supplies its own.
  context.attachments ??= [];
  context.settleGroupComposer ??= settleGroupComposer;
  context.describeGroupContextOutcome ??= describeGroupContextOutcome;
  context.groupBrowserContextAllowed ??= groupBrowserContextAllowed;
  context.renderAttachments ??= () => {};
  context.renderContextWindow ??= () => {};
  context.forgetComposerDraft ??= () => {};
  context.persistCurrentComposerDraft ??= () => {};
  if (!vm.isContext(context)) vm.createContext(context);
  for (const name of ['claimGroupComposer', 'releaseGroupComposer', 'abortAttachedGroupTurn', 'abortBackgroundGroupTurn', 'backgroundTurnFor', 'reattachBackgroundGroupTurn', 'commitDetachedGroupTranscript']) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing group lifecycle dependency: ${name}`);
    const end = source.indexOf('\nfunction ', start + 10);
    vm.runInContext(source.slice(start, end < 0 ? source.length : end), context);
  }
}

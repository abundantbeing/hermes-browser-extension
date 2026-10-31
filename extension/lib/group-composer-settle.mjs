/**
 * What a group send takes out of the composer once its turn is fully prepared.
 *
 * The composer is only settled AFTER the browser context and screenshots were
 * resolved: a preflight refusal (tab changed, consent withdrawn, too many
 * screenshots) must leave the draft and its attachments where the user can fix
 * them, and a delivered turn must not leave its tab screenshot behind to ride
 * along with the next message. Only the text and attachments the turn actually
 * carried are removed; anything typed or attached while the turn was being
 * prepared stays.
 */
export function settleGroupComposer({ draft = '', attachments = [] } = {}, { text = '', attachments: sent = [] } = {}) {
  const sentIds = new Set((Array.isArray(sent) ? sent : []).map((item) => item?.id));
  const remaining = (Array.isArray(attachments) ? attachments : []).filter((item) => !sentIds.has(item?.id));
  const current = String(draft ?? '');
  const nextDraft = current.trim() === String(text ?? '').trim() ? '' : current;
  return { draft: nextDraft, attachments: remaining, empty: nextDraft.trim() === '' && remaining.length === 0 };
}

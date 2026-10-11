export const EXEC_APPROVAL_CHOICES = Object.freeze(['once', 'session', 'always', 'deny']);

export const DEFAULT_EXEC_APPROVAL_CHOICES = EXEC_APPROVAL_CHOICES;

export function normalizeExecApprovalChoices(choices) {
  if (!Array.isArray(choices) || !choices.length) return EXEC_APPROVAL_CHOICES;
  const offered = choices
    .map((choice) => String(choice).trim().toLowerCase())
    .filter((choice) => EXEC_APPROVAL_CHOICES.includes(choice));
  return offered.length ? offered : [];
}

export function execApprovalRequestPayload(choice, requestId = '') {
  if (!EXEC_APPROVAL_CHOICES.includes(choice)) return null;
  const id = String(requestId || '').trim();
  return id ? { choice, request_id: id } : { choice };
}

export function isExecApprovalRetired(status, message = '') {
  if (Number(status) === 409) return true;
  return /no (pending|active) approval/i.test(String(message || ''));
}

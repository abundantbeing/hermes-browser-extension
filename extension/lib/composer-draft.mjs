export const COMPOSER_DRAFT_STORAGE_PREFIX = 'hermesBrowserComposerDraft';
export const COMPOSER_DRAFT_MAX_BYTES = 2_500_000;
export const COMPOSER_DRAFT_DATA_URL_MAX_CHARS = 400_000;

export function composerDraftStorageKey(instanceId = 'default') {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}:${String(instanceId || '').trim() || 'default'}`;
}

export function composerDraftIsEmpty(draft = null) {
  if (!draft || typeof draft !== 'object') return true;
  const text = String(draft.text || '').trim();
  const attachments = Array.isArray(draft.attachments) ? draft.attachments : [];
  return !text && attachments.length === 0;
}

export function serializeComposerAttachment(attachment = {}, { allowDataUrl = true } = {}) {
  if (!attachment || typeof attachment !== 'object') return null;
  const kind = String(attachment.kind || '').trim();
  if (!kind) return null;
  const label = String(attachment.label || attachment.name || '').trim();
  const name = String(attachment.name || attachment.label || '').trim();
  const localPath = String(attachment.localPath || '').trim();
  const next = {
    id: String(attachment.id || ''),
    kind,
    label,
    name,
    detail: String(attachment.detail || ''),
    localPath,
    savedFilename: String(attachment.savedFilename || ''),
    mimeType: String(attachment.mimeType || attachment.type || ''),
    type: String(attachment.type || attachment.mimeType || ''),
    savedSize: Number(attachment.savedSize || 0) || 0,
    size: Number(attachment.size || attachment.savedSize || 0) || 0,
    text: String(attachment.text || ''),
  };
  const dataUrl = String(attachment.dataUrl || '');
  if (
    allowDataUrl
    && !localPath
    && dataUrl.startsWith('data:image/')
    && dataUrl.length <= COMPOSER_DRAFT_DATA_URL_MAX_CHARS
  ) {
    next.dataUrl = dataUrl;
  }
  return next;
}

export function serializeComposerDraft({ text = '', attachments = [] } = {}, { allowDataUrl = true } = {}) {
  return {
    version: 1,
    text: String(text || ''),
    attachments: (Array.isArray(attachments) ? attachments : [])
      .map((item) => serializeComposerAttachment(item, { allowDataUrl }))
      .filter(Boolean),
  };
}

export function persistComposerDraft(storage, { instanceId, text = '', attachments = [] } = {}) {
  if (!storage || typeof storage.setItem !== 'function') return { ok: false, reason: 'no-storage' };
  const key = composerDraftStorageKey(instanceId);
  const draft = serializeComposerDraft({ text, attachments });
  if (composerDraftIsEmpty(draft)) {
    try { storage.removeItem?.(key); } catch { /* quota / private mode */ }
    return { ok: true, cleared: true };
  }
  try {
    let encoded = JSON.stringify(draft);
    let slimmed = false;
    if (encoded.length > COMPOSER_DRAFT_MAX_BYTES) {
      const slim = serializeComposerDraft({ text, attachments }, { allowDataUrl: false });
      encoded = JSON.stringify(slim);
      slimmed = true;
    }
    if (encoded.length > COMPOSER_DRAFT_MAX_BYTES) {
      return { ok: false, reason: 'too-large' };
    }
    storage.setItem(key, encoded);
    return { ok: true, slimmed };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

export function loadComposerDraft(storage, { instanceId } = {}) {
  try {
    const raw = storage?.getItem?.(composerDraftStorageKey(instanceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return null;
    const draft = serializeComposerDraft(parsed);
    return composerDraftIsEmpty(draft) ? null : draft;
  } catch {
    return null;
  }
}

export function clearComposerDraft(storage, { instanceId } = {}) {
  try {
    storage?.removeItem?.(composerDraftStorageKey(instanceId));
    return true;
  } catch {
    return false;
  }
}

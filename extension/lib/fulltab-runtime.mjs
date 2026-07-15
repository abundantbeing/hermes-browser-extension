import { modelRuntimeAckState, normalizeRuntimeModelPayload } from './common.mjs';
import { normalizeBrowserRuntimeEvent, reduceAssistantStreamText } from './runtime-events.mjs';

function responseErrorDetail(payload = {}, fallback = 'Hermes request failed.') {
  return String(
    payload?.error?.message
    || payload?.error
    || payload?.message
    || fallback,
  ).trim();
}

export function modelLockRequestOutcome({ responseOk = false, status = 0, payload = {}, requested = {} } = {}) {
  if (!responseOk) {
    const errorCode = String(payload?.error?.code || payload?.code || '').trim();
    if (Number(status) === 404 && !errorCode) {
      return {
        ok: true,
        state: 'legacy',
        detail: 'Connected Hermes Gateway does not expose session model locks yet; Hermes will confirm the requested model on the next turn.',
        rollback: false,
      };
    }
    return {
      ok: false,
      state: 'failed',
      detail: responseErrorDetail(payload, `Hermes model lock failed (${status || 'unknown status'}).`),
      rollback: true,
    };
  }

  const runtime = payload?.runtime && typeof payload.runtime === 'object' ? payload.runtime : payload;
  const normalized = normalizeRuntimeModelPayload(runtime);
  const ack = modelRuntimeAckState({ requested, runtime });
  const detail = ack.detail || [normalized.provider, normalized.model].filter(Boolean).join(' · ');
  if (['accepted', 'confirmed'].includes(normalized.modelLock.toLowerCase())) {
    return { ok: true, state: 'accepted', detail, rollback: false };
  }
  if (ack.state === 'confirmed') {
    return { ok: true, state: 'confirmed', detail, rollback: false };
  }
  if (ack.state === 'mismatch') {
    return { ok: false, state: 'mismatch', detail, rollback: true };
  }
  return {
    ok: true,
    state: 'pending',
    detail: ack.detail || 'Waiting for Hermes runtime metadata.',
    rollback: false,
  };
}

export function runSteerFailureState({ status = 0, payload = {} } = {}) {
  const code = String(payload?.error?.code || payload?.code || '').trim().toLowerCase();
  const fallback = Number(status) === 404
    ? 'Active-run steering is unavailable. Update Hermes Gateway to a build with /v1/runs/{run_id}/steer support, then reload Hermes Browser.'
    : `Hermes steer failed (${status || 'unknown status'}).`;
  const detail = responseErrorDetail(payload, fallback);
  return {
    staleRun: Number(status) === 409 || (Number(status) === 404 && code === 'run_not_found'),
    detail,
  };
}

export function parseSseBlock(block = '') {
  const event = { type: 'message', data: '' };
  for (const line of String(block).split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event.type = line.slice(6).trim();
    if (line.startsWith('data:')) event.data += `${line.slice(5).trim()}\n`;
  }
  event.data = event.data.trim();
  try { event.json = event.data ? JSON.parse(event.data) : {}; } catch { event.json = {}; }
  return event;
}

export async function readHermesSse(response, { onAssistant, onTool, onRuntime, onRun, signal } = {}) {
  if (!response?.body) throw new Error('Hermes stream did not return a response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stream = { text: '', finalized: false };

  const processBlock = (block) => {
    const event = parseSseBlock(block);
    const data = event.json || {};
    if (event.type === 'run.started') onRun?.(data.run_id || data.runId || '');
    if (['assistant.delta', 'assistant.completed', 'run.completed'].includes(event.type)) {
      stream = reduceAssistantStreamText(stream, { type: event.type, data });
      onAssistant?.(stream.text, { finalized: stream.finalized, event: event.type, data });
    }
    if (event.type.startsWith('tool.') || event.type === 'hermes.tool.progress') {
      onTool?.(normalizeBrowserRuntimeEvent({ type: event.type, data }));
    }
    if (event.type === 'run.completed') onRuntime?.(data);
    if (event.type === 'error') throw new Error(data.message || event.data || 'Hermes stream error');
  };

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      throw new DOMException('Hermes turn stopped', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) if (block.trim()) processBlock(block);
  }
  buffer += decoder.decode();
  if (buffer.trim()) processBlock(buffer);
  return stream.text;
}

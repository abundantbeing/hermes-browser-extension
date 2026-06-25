// agent-discovery.mjs
// Discover Hermes agent gateways on the local network by probing /health
// across a configurable port range. This is the multi-agent / multi-port
// discovery layer that backs the "Connected agent" picker in the side panel
// settings. Extracted from sidepanel.js for testability.

import { normalizeGatewayUrl } from './common.mjs';

export const DEFAULT_AGENT_PORTS = Object.freeze([8642, 8643, 8644, 8645, 8646]);
const PROBE_TIMEOUT_MS = 1500;

export async function probeGatewayHealth(baseUrl, { apiKey = '', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!baseUrl) return { ok: false, error: 'no-url' };
  const url = `${normalizeGatewayUrl(baseUrl)}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const response = await fetch(url, { headers, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      version: body.version || '',
      platform: body.platform || '',
      model: body.model || '',
    };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout' : (error?.message || 'error') };
  } finally {
    clearTimeout(timer);
  }
}

export function deriveAgentName(port, probe) {
  if (!probe || !probe.ok) return null;
  if (probe.platform !== 'hermes-agent') return null;
  // Future: gateway could expose its profile name in /health/detailed.
  // For now, port-derived name is the only reliable label.
  return `agent-${port}`;
}

export async function discoverLocalAgents({
  ports = DEFAULT_AGENT_PORTS,
  apiKey = '',
  host = '127.0.0.1',
  scheme = 'http',
} = {}) {
  if (!Array.isArray(ports) || !ports.length) return [];
  const candidates = ports.map((port) => ({
    url: `${scheme}://${host}:${port}`,
    port,
  }));
  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const probe = await probeGatewayHealth(candidate.url, { apiKey });
      return {
        ...candidate,
        ok: probe.ok,
        status: probe.status,
        version: probe.version,
        model: probe.model,
        error: probe.error || '',
        name: deriveAgentName(candidate.port, probe),
      };
    }),
  );
  return results;
}

export function activeAgents(results = []) {
  return results.filter((agent) => agent.ok && agent.name);
}

export function parseAgentPortsInput(value = '') {
  if (typeof value !== 'string') return [];
  const parsed = value
    .split(/[\s,]+/)
    .map((token) => Number.parseInt(token, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 65535);
  // de-dupe, preserve order
  const seen = new Set();
  const out = [];
  for (const port of parsed) {
    if (seen.has(port)) continue;
    seen.add(port);
    out.push(port);
  }
  return out;
}

export const AGENT_DISCOVERY_DEFAULTS = Object.freeze({
  ports: [...DEFAULT_AGENT_PORTS],
  host: '127.0.0.1',
  scheme: 'http',
});

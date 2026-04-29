import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';

import { buildE2EERequest, decryptResponse } from '../lib/chutes/ChutesE2EECrypto.js';
import { ChutesE2EETransport } from '../lib/chutes/ChutesE2EETransport.js';
import { DEFAULT_API_BASE, MLKEM_PK_SIZE } from '../lib/chutes/constants.js';
import { _fetchWithRetry } from '../lib/chutes/utils.js';

export const API_KEY = process.env.CHUTES_API_KEY || '';
export const LIVE_ENABLED = process.env.RUN_LIVE_TESTS === '1';
export const LIVE_TEST_TIMEOUT_MS = readPositiveInt('LIVE_TEST_TIMEOUT_MS', 30_000);
export const LIVE_STREAM_READ_TIMEOUT_MS = readPositiveInt('LIVE_STREAM_READ_TIMEOUT_MS', 12_000);

const LIVE_MODEL = process.env.LIVE_MODEL || '';
const LIVE_ALLOW_BUSY_MODEL = process.env.LIVE_ALLOW_BUSY_MODEL === '1';
const LIVE_MAX_UTILIZATION = readRatio('LIVE_MAX_UTILIZATION', 0.9);
const LIVE_MAX_RATE_LIMIT_RATIO_5M = readRatio('LIVE_MAX_RATE_LIMIT_RATIO_5M', 0.25);
const LIVE_INSTANCE_PROBE_TIMEOUT_MS = readPositiveInt('LIVE_INSTANCE_PROBE_TIMEOUT_MS', 5_000);
const LIVE_DIAGNOSTICS = process.env.LIVE_DIAGNOSTICS === '1';

const SKIP_MSG = 'Skipped live Chutes tests - set CHUTES_API_KEY and RUN_LIVE_TESTS=1.';

let skipNoticeShown = false;
let liveContextPromise;

class LiveModelUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveModelUnavailableError';
  }
}

export function liveTest(name, fn) {
  test(name, { timeout: LIVE_TEST_TIMEOUT_MS }, async (t) => {
    if (!LIVE_ENABLED) {
      if (!skipNoticeShown) {
        console.log(SKIP_MSG);
        skipNoticeShown = true;
      }
      return;
    }
    if (!API_KEY) {
      throw new Error('CHUTES_API_KEY is required when RUN_LIVE_TESTS=1.');
    }
    try {
      await fn(t);
    } catch (err) {
      if (err instanceof LiveModelUnavailableError) {
        if (!skipNoticeShown) {
          console.log(`  ${err.message}`);
          skipNoticeShown = true;
        }
        return;
      }
      throw err;
    }
  });
}

export async function getLiveContext() {
  if (!liveContextPromise) {
    liveContextPromise = createLiveContext();
  }
  return liveContextPromise;
}

export function assertReadableText(text, label = 'response text') {
  assert.equal(typeof text, 'string', `${label} must be a string`);
  const trimmed = text.trim();
  assert.ok(trimmed.length > 0, `${label} must not be empty`);
  assert.ok(!/^\d+(,\d+)*$/.test(trimmed), `${label} must not be comma-separated ASCII codes`);
  assert.ok(/[A-Za-z]{2,}/.test(trimmed), `${label} must contain readable text`);
}

export async function readSseChunks(response, {
  maxReads = 30,
  stopAfterDataLines = null,
  readTimeoutMs = LIVE_STREAM_READ_TIMEOUT_MS,
} = {}) {
  assert.ok(response.body, 'stream response must include a body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = 0;
  let contentChunks = 0;
  let fullText = '';
  let sawDone = false;

  try {
    for (let i = 0; i < maxReads; i++) {
      const { done, value } = await readWithTimeout(reader, readTimeoutMs);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (!parsed) continue;

        dataLines++;
        if (parsed.done) {
          sawDone = true;
          continue;
        }

        if (parsed.text) {
          fullText += parsed.text;
          contentChunks++;
        }
      }

      if (stopAfterDataLines && dataLines >= stopAfterDataLines) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return { dataLines, contentChunks, fullText, sawDone };
}

export function describeSelectedModel(ctx) {
  return formatCandidate(ctx.selected);
}

async function createLiveContext() {
  const transport = new ChutesE2EETransport({ apiKey: API_KEY });
  const [metadata, utilization] = await Promise.all([
    transport.getModelMetadata(),
    fetchChutesUtilization(),
  ]);

  const teeModels = metadata.filter(isReasoningTextTeeModel);
  const candidates = buildCandidates(teeModels, utilization);
  const utilizationViableModels = candidates.filter((candidate) => !candidate.rejectionReason);
  const selected = await selectUsableCandidate(transport, candidates, utilizationViableModels);

  if (!selected?.instanceProbe) {
    throw new LiveModelUnavailableError(buildNoCandidateMessage(candidates));
  }

  console.log(`  Selected live TEE model: ${formatCandidate(selected)}`);

  return {
    transport,
    model: selected.id,
    chuteId: selected.chuteId,
    selected,
    teeModels,
    candidates,
    viableModels: utilizationViableModels,
    utilization,
  };
}

async function selectUsableCandidate(transport, candidates, utilizationViableModels) {
  if (LIVE_MODEL) {
    const selected = candidates.find((candidate) => (
      candidate.id === LIVE_MODEL ||
      candidate.chuteId === LIVE_MODEL
    ));
    if (!selected) {
      throw new Error(`LIVE_MODEL=${LIVE_MODEL} was not found in /v1/models TEE metadata.`);
    }
    if (selected.rejectionReason && !LIVE_ALLOW_BUSY_MODEL) {
      throw new Error(
        `LIVE_MODEL=${LIVE_MODEL} is not suitable for live tests: ${selected.rejectionReason}. ` +
          'Set LIVE_ALLOW_BUSY_MODEL=1 only when intentionally debugging that model.',
      );
    }

    const probe = await probeCandidate(transport, selected);
    if (!probe.ok) {
      throw new Error(
        `LIVE_MODEL=${LIVE_MODEL} failed E2EE instance discovery: ${probe.reason}. ` +
          'Choose another LIVE_MODEL or wait for the chute to recover.',
      );
    }
    selected.instanceProbe = probe;
    return selected;
  }

  for (const candidate of sortedCandidates(utilizationViableModels)) {
    const probe = await probeCandidate(transport, candidate);
    if (probe.ok) {
      candidate.instanceProbe = probe;
      return candidate;
    }
    candidate.rejectionReason = `E2EE instance discovery failed: ${probe.reason}`;
  }

  return null;
}

async function probeCandidate(transport, candidate) {
  const url = `${transport._apiBase}/e2e/instances/${candidate.chuteId}`;
  let res;
  try {
    res = await _fetchWithRetry(url, {
      headers: transport._discovery.getAuth(),
      signal: AbortSignal.timeout(LIVE_INSTANCE_PROBE_TIMEOUT_MS),
    }, { maxRetries: 0, baseDelay: 0 });
  } catch (err) {
    return { ok: false, reason: formatProbeError(err) };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, reason: `invalid JSON from instance discovery: ${formatProbeError(err)}` };
  }

  const instances = (data.instances || []).map((inst) => ({
    instanceId: inst.instance_id,
    e2ePubkey: inst.e2e_pubkey,
    nonces: [...(inst.nonces || [])],
  }));
  const usable = instances.find((inst) => isUsableInstance(inst));

  if (!usable) {
    return { ok: false, reason: 'no usable E2EE instances with nonce material' };
  }

  const nonce = usable.nonces.shift();
  const invokeProbe = await probeInvoke(transport, candidate, usable, nonce);
  if (!invokeProbe.ok) return invokeProbe;

  transport._discovery._nonceCache.set(candidate.chuteId, {
    instances,
    expiresAt: Date.now() + (data.nonce_expires_in || 55) * 1000,
  });

  return { ok: true, instances: instances.length };
}

async function probeInvoke(transport, candidate, instance, nonce) {
  const payload = {
    model: candidate.id,
    messages: [{ role: 'user', content: 'Reply OK.' }],
    stream: false,
    max_tokens: 8,
  };
  const { blob, responseSk } = await buildE2EERequest(instance.e2ePubkey, payload);

  let res;
  try {
    res = await _fetchWithRetry(`${transport._apiBase}/e2e/invoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'X-Chute-Id': candidate.chuteId,
        'X-Instance-Id': instance.instanceId,
        'X-E2E-Nonce': nonce,
        'X-E2E-Stream': 'false',
        'X-E2E-Path': '/v1/chat/completions',
        'Content-Type': 'application/octet-stream',
      },
      body: blob,
      signal: AbortSignal.timeout(LIVE_INSTANCE_PROBE_TIMEOUT_MS),
    }, { maxRetries: 0, baseDelay: 0 });
  } catch (err) {
    return { ok: false, reason: `E2EE invoke probe failed: ${formatProbeError(err)}` };
  }

  try {
    const decrypted = await decryptResponse(Buffer.from(await res.arrayBuffer()), responseSk);
    const msg = decrypted.choices?.[0]?.message;
    const text = msg?.content || msg?.reasoning_content || '';
    if (!text) {
      return { ok: false, reason: 'E2EE invoke probe returned no text' };
    }
  } catch (err) {
    return { ok: false, reason: `E2EE invoke probe returned undecryptable data: ${formatProbeError(err)}` };
  }

  return { ok: true };
}

async function fetchChutesUtilization() {
  const res = await _fetchWithRetry(`${DEFAULT_API_BASE}/chutes/utilization`, {
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
    signal: AbortSignal.timeout(15_000),
  }, { maxRetries: 1, baseDelay: 500 });
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('/chutes/utilization returned an unexpected payload.');
  }
  return data;
}

function buildCandidates(models, utilization) {
  const utilizationByChuteId = new Map();
  const utilizationByName = new Map();

  for (const entry of utilization) {
    if (entry?.chute_id) utilizationByChuteId.set(entry.chute_id, entry);
    if (entry?.name && entry.name !== '[private chute]') utilizationByName.set(entry.name, entry);
  }

  return models.map((model) => {
    const usage = utilizationByChuteId.get(model.chuteId) || utilizationByName.get(model.id) || null;
    const activeInstances = positiveNumber(
      usage?.active_instance_count,
      usage?.instance_count,
      usage?.total_instance_count,
      0,
    );
    const utilizationCurrent = ratioValue(usage?.utilization_current, 1);
    const utilization5m = ratioValue(usage?.utilization_5m, utilizationCurrent);
    const rateLimitRatio5m = ratioValue(usage?.rate_limit_ratio_5m, 1);

    const candidate = {
      id: model.id,
      chuteId: model.chuteId,
      model,
      utilization: usage,
      activeInstances,
      utilizationCurrent,
      utilization5m,
      rateLimitRatio5m,
      rejectionReason: null,
    };
    candidate.rejectionReason = getRejectionReason(candidate);
    return candidate;
  });
}

function isReasoningTextTeeModel(model) {
  const inputModalities = Array.isArray(model.inputModalities) ? model.inputModalities : [];
  const outputModalities = Array.isArray(model.outputModalities) ? model.outputModalities : [];
  const features = Array.isArray(model.supportedFeatures) ? model.supportedFeatures : [];

  return Boolean(model.confidentialCompute) &&
    model.id.includes('-TEE') &&
    inputModalities.includes('text') &&
    outputModalities.includes('text') &&
    features.includes('reasoning');
}

function sortedCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const scoreDelta = candidateScore(a) - candidateScore(b);
    if (scoreDelta !== 0) return scoreDelta;
    return a.id.localeCompare(b.id);
  });
}

function candidateScore(candidate) {
  const singleInstancePenalty = candidate.activeInstances < 2 ? 0.3 : 0;
  const activeInstanceBonus = Math.min(candidate.activeInstances, 20) * 0.01;
  return candidate.utilizationCurrent +
    candidate.utilization5m * 0.5 +
    candidate.rateLimitRatio5m * 2 +
    singleInstancePenalty -
    activeInstanceBonus;
}

function getRejectionReason(candidate) {
  if (!candidate.utilization) return 'missing from /chutes/utilization';
  if (candidate.activeInstances <= 0) return 'no active instances';
  if (candidate.utilizationCurrent >= LIVE_MAX_UTILIZATION) {
    return `current utilization ${formatPercent(candidate.utilizationCurrent)} >= ${formatPercent(LIVE_MAX_UTILIZATION)}`;
  }
  if (candidate.utilization5m >= LIVE_MAX_UTILIZATION) {
    return `5m utilization ${formatPercent(candidate.utilization5m)} >= ${formatPercent(LIVE_MAX_UTILIZATION)}`;
  }
  if (candidate.rateLimitRatio5m >= LIVE_MAX_RATE_LIMIT_RATIO_5M) {
    return `5m rate-limit ratio ${formatPercent(candidate.rateLimitRatio5m)} >= ${formatPercent(LIVE_MAX_RATE_LIMIT_RATIO_5M)}`;
  }
  return null;
}

function isUsableInstance(inst) {
  return inst.instanceId &&
    inst.e2ePubkey &&
    Buffer.from(inst.e2ePubkey, 'base64').length === MLKEM_PK_SIZE &&
    inst.nonces.length > 0;
}

function buildNoCandidateMessage(candidates) {
  const rejected = [...candidates]
    .sort((a, b) => candidateScore(a) - candidateScore(b))
    .slice(0, 8)
    .map((candidate) => `- ${formatCandidate(candidate)}: ${candidate.rejectionReason || 'unknown'}`)
    .join('\n');
  const failedCandidates = candidates.filter((candidate) => candidate.rejectionReason);
  const topReason = mostCommon(failedCandidates.map((candidate) => candidate.rejectionReason));
  const summary = `No usable live E2EE model was available; ` +
    `checked ${failedCandidates.length} candidates; top failure: ${topReason || 'unknown'}.`;

  if (!LIVE_DIAGNOSTICS) {
    return `${summary} Set LIVE_DIAGNOSTICS=1 for candidate details.`;
  }

  return [
    summary,
    `Thresholds: current utilization < ${formatPercent(LIVE_MAX_UTILIZATION)}, ` +
      `5m utilization < ${formatPercent(LIVE_MAX_UTILIZATION)}, ` +
      `5m rate-limit ratio < ${formatPercent(LIVE_MAX_RATE_LIMIT_RATIO_5M)}.`,
    rejected ? `Closest candidates:\n${rejected}` : 'No reasoning-capable TEE text models were found.',
  ].join('\n');
}

function parseSseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;

  const data = trimmed.slice(5).trim();
  if (!data) return null;
  if (data === '[DONE]') return { done: true, text: '' };

  try {
    const parsed = JSON.parse(data);
    return {
      done: false,
      text: parsed.choices?.[0]?.delta?.content ||
        parsed.choices?.[0]?.delta?.reasoning_content ||
        parsed.choices?.[0]?.message?.content ||
        parsed.choices?.[0]?.message?.reasoning_content ||
        '',
    };
  } catch {
    return { done: false, text: '' };
  }
}

function readWithTimeout(reader, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting ${Math.round(timeoutMs / 1000)}s for the next SSE chunk.`));
    }, timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timeoutId);
        resolve(result);
      },
      (err) => {
        clearTimeout(timeoutId);
        reject(err);
      },
    );
  });
}

function formatCandidate(candidate) {
  return `${candidate.id} ` +
    `(active ${candidate.activeInstances}, ` +
    `current ${formatPercent(candidate.utilizationCurrent)}, ` +
    `5m ${formatPercent(candidate.utilization5m)}, ` +
    `rate-limit 5m ${formatPercent(candidate.rateLimitRatio5m)})`;
}

function formatProbeError(err) {
  if (!err) return 'unknown error';
  if (err.status) return `HTTP ${err.status}`;
  if (err.code) return `${err.code}: ${err.message}`;
  if (err.message) return err.message;
  return String(err);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function positiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function ratioValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mostCommon(values) {
  let bestValue = '';
  let bestCount = 0;
  const counts = new Map();
  for (const value of values) {
    const count = (counts.get(value) || 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  return bestValue;
}

function readPositiveInt(name, fallback) {
  const number = Number(process.env[name]);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readRatio(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const number = Number(raw.replace(/%$/, ''));
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return number > 1 ? number / 100 : number;
}

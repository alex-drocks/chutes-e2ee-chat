/**
 * Chutes.ai E2EE transport for direct chat completions.
 *
 * Handles model discovery, instance resolution, request encryption,
 * and response decryption for both streaming and non-streaming.
 */

import { ChutesDiscoveryManager } from './ChutesDiscoveryManager.js';
import { _fetchWithRetry } from './utils.js';
import { ChutesE2EESecurityError, ChutesError } from './errors.js';
import {
  DEFAULT_API_BASE,
  DEFAULT_MODELS_BASE,
  DEFAULT_FETCH_TIMEOUT_MS,
  MLKEM_PK_SIZE,
} from './constants.js';
import {
  buildE2EERequest,
  decryptResponse,
  decryptStreamInit,
  decryptStreamChunk,
} from './ChutesE2EECrypto.js';

export class ChutesE2EETransport {
  constructor({ apiKey, apiBase = DEFAULT_API_BASE, modelsBase = DEFAULT_MODELS_BASE }) {
    this._apiKey = apiKey;
    this._apiBase = apiBase.replace(/\/$/, '');
    this._discovery = new ChutesDiscoveryManager({ apiKey, apiBase, modelsBase });
  }

  /** Update the stored API key and refresh the transport's auth state. */
  setApiKey(apiKey) {
    this._apiKey = apiKey;
    this._discovery.setAuth(apiKey);
  }

  /** Return available model names from discovery. */
  async getModels() {
    await this._discovery._maybeRefreshModelMap();
    return [...this._discovery._modelMap.keys()];
  }

  /** Return model names plus advertised modalities/features from discovery. */
  async getModelMetadata() {
    await this._discovery._maybeRefreshModelMap();
    return [...this._discovery._modelMeta.values()];
  }

  /**
   * Send an encrypted chat completion request.
   *
   * @param {Object} params  — OpenAI-style { model, messages, stream?, max_tokens?, ... }
   * @param {Object} [options] — optional { signal } for caller-driven aborts
   * @returns {Promise<{ response: Response, abort: () => void }>}
   *
   * For stream=true, the response body is a ReadableStream of SSE lines.
   * For stream=false, the response body is JSON after decryption.
   */
  async chat(params, options = {}) {
    const model = params.model;
    if (!model) throw new ChutesError('Missing "model" in chat params');
    throwIfAborted(options.signal);

    const stream = Boolean(params.stream);
    const chuteId = await this._discovery.resolveE2EEChuteId(model);
    throwIfAborted(options.signal);
    const instance = await this._discovery.getNonce(chuteId);
    throwIfAborted(options.signal);
    validateE2EEInstanceMaterial(instance);

    const { blob, responseSk } = await buildE2EERequest(instance.e2ePubkey, params);

    const invokeUrl = `${this._apiBase}/e2e/invoke`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS.invoke);
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      options.signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const clearInvokeTimeout = () => clearTimeout(timeoutId);
    const cleanupAbortWiring = () => {
      clearInvokeTimeout();
      if (options.signal) {
        options.signal.removeEventListener('abort', abortFromCaller);
      }
    };

    let invokeRes;
    try {
      invokeRes = await _fetchWithRetry(invokeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          'X-Chute-Id': chuteId,
          'X-Instance-Id': instance.instanceId,
          'X-E2E-Nonce': instance.nonce,
          'X-E2E-Stream': String(stream).toLowerCase(),
          'X-E2E-Path': '/v1/chat/completions',
          'Content-Type': 'application/octet-stream',
        },
        body: blob,
        signal: controller.signal,
      }, { maxRetries: 0 });
    } catch (err) {
      cleanupAbortWiring();
      throw err;
    }

    if (!invokeRes.ok) {
      cleanupAbortWiring();
      const text = await invokeRes.text().catch(() => '');
      throw new ChutesError(`Chutes E2EE invoke failed: ${invokeRes.status} ${invokeRes.statusText} — ${text}`);
    }

    if (stream) {
      // The invoke timeout covers connection setup. Once headers are received,
      // a valid model response may stream for longer than the setup timeout.
      clearInvokeTimeout();
      if (!invokeRes.body) {
        cleanupAbortWiring();
        throw new ChutesError('Chutes E2EE invoke returned an empty stream body');
      }
      const body = this._decorateStream(invokeRes.body, responseSk, {
        onClose: cleanupAbortWiring,
      });
      return {
        response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        abort: () => {
          controller.abort();
          cleanupAbortWiring();
        },
      };
    }

    let decrypted;
    try {
      const bodyBuffer = Buffer.from(await invokeRes.arrayBuffer());
      decrypted = await decryptResponse(bodyBuffer, responseSk);
    } finally {
      cleanupAbortWiring();
    }

    return {
      response: new Response(JSON.stringify(decrypted), { status: 200, headers: { 'content-type': 'application/json' } }),
      abort: () => controller.abort(),
    };
  }

  _decorateStream(rawBody, responseSk, {
    idleTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS.invoke,
    onClose = () => {},
  } = {}) {
    const reader = rawBody.getReader();
    let streamKey = null;
    let buffer = '';
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const timeoutMessage = `Chutes E2EE stream stalled for ${Math.round(idleTimeoutMs / 1000)} seconds`;
    let closed = false;
    let idleTimeoutId = null;

    const clearIdleTimeout = () => {
      if (idleTimeoutId) {
        clearTimeout(idleTimeoutId);
        idleTimeoutId = null;
      }
    };

    return new ReadableStream({
      start(controller) {
        const parseFailures = { count: 0 };

        const fail = (err) => {
          if (closed) return;
          closed = true;
          clearIdleTimeout();
          onClose();
          reader.cancel(err).catch(() => {});
          controller.error(err);
        };

        const resetIdleTimeout = () => {
          clearIdleTimeout();
          idleTimeoutId = setTimeout(() => {
            fail(new Error(timeoutMessage));
          }, idleTimeoutMs);
        };

        const close = () => {
          if (closed) return;
          closed = true;
          clearIdleTimeout();
          onClose();
          controller.close();
        };

        const pump = async () => {
          resetIdleTimeout();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (closed) return;
              if (done) break;
              resetIdleTimeout();

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const result = await processSSELineAsync(line, responseSk, streamKey, parseFailures);
                if (result) {
                  if (result.type === 'stream_key') {
                    streamKey = result.key;
                  } else if (result.type === 'chunk') {
                    controller.enqueue(encoder.encode(result.data));
                  } else if (result.type === 'done') {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                  }
                }
              }
            }

            clearIdleTimeout();
            buffer += decoder.decode();

            if (buffer.trim()) {
              const result = await processSSELineAsync(buffer, responseSk, streamKey, parseFailures);
              if (result && result.type === 'chunk') {
                controller.enqueue(encoder.encode(result.data));
              }
            }

            close();
          } catch (err) {
            fail(err);
          }
        };
        pump();
      },
      cancel(reason) {
        if (closed) return;
        closed = true;
        clearIdleTimeout();
        onClose();
        reader.cancel(reason).catch(() => {});
      },
    });
  }
}

function validateE2EEInstanceMaterial(instance) {
  if (!isSafeHeaderValue(instance?.instanceId, 256)) {
    throw new ChutesE2EESecurityError('E2EE instance discovery returned an invalid instance id.');
  }

  if (!isSafeHeaderValue(instance?.nonce, 4096)) {
    throw new ChutesE2EESecurityError('E2EE instance discovery returned an invalid nonce.');
  }

  if (typeof instance?.e2ePubkey !== 'string') {
    throw new ChutesE2EESecurityError('E2EE instance discovery returned a missing public key.');
  }

  let decodedLength = 0;
  try {
    decodedLength = Buffer.from(instance.e2ePubkey, 'base64').length;
  } catch {
    decodedLength = 0;
  }

  if (decodedLength !== MLKEM_PK_SIZE) {
    throw new ChutesE2EESecurityError(
      `E2EE instance public key must decode to ${MLKEM_PK_SIZE} bytes, got ${decodedLength}.`,
    );
  }
}

function isSafeHeaderValue(value, maxLength) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\r\n]/.test(value);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  throw err;
}

async function processSSELineAsync(line, responseSk, currentStreamKey, parseFailures) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data: ')) return null;

  const raw = trimmed.slice(6).trim();
  if (raw === '[DONE]') return { type: 'done' };
  if (!raw) return null;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    parseFailures.count += 1;
    if (parseFailures.count >= 10) {
      throw new Error('Too many consecutive SSE parse failures — stream may be corrupted');
    }
    return null;
  }
  parseFailures.count = 0;

  if (event.e2e_init !== undefined) {
    const key = await decryptStreamInit(responseSk, event.e2e_init);
    return { type: 'stream_key', key };
  }

  if (event.e2e !== undefined) {
    if (!currentStreamKey) {
      throw new Error('Received e2e chunk before e2e_init');
    }
    const decrypted = decryptStreamChunk(event.e2e, currentStreamKey);
    return { type: 'chunk', data: decrypted + '\n\n' };
  }

  if (event.usage !== undefined) {
    return { type: 'chunk', data: trimmed + '\n\n' };
  }

  if (event.e2e_error !== undefined) {
    const message = typeof event.e2e_error === 'string'
      ? event.e2e_error
      : event.e2e_error?.message || JSON.stringify(event.e2e_error);
    throw new Error(message || 'Chutes E2EE stream failed');
  }

  return null;
}

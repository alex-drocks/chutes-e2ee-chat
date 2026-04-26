/**
 * Chutes.ai E2EE transport for direct chat completions.
 *
 * Handles model discovery, instance resolution, request encryption,
 * and response decryption for both streaming and non-streaming.
 */

import { ChutesDiscoveryManager } from './ChutesDiscoveryManager.js';
import {
  buildE2EERequest,
  decryptResponse,
  decryptStreamInit,
  decryptStreamChunk,
} from './ChutesE2EECrypto.js';

const DEFAULT_API_BASE = 'https://api.chutes.ai';
const DEFAULT_MODELS_BASE = 'https://llm.chutes.ai';

export class ChutesE2EETransport {
  constructor({ apiKey, apiBase = DEFAULT_API_BASE, modelsBase = DEFAULT_MODELS_BASE }) {
    this._apiKey = apiKey;
    this._apiBase = apiBase.replace(/\/$/, '');
    this._discovery = new ChutesDiscoveryManager({ apiKey, apiBase, modelsBase });
  }

  /** Return available model names from discovery. */
  async getModels() {
    await this._discovery._maybeRefreshModelMap();
    return [...this._discovery._modelMap.keys()];
  }

  /**
   * Send an encrypted chat completion request.
   *
   * @param {Object} params  — OpenAI-style { model, messages, stream?, max_tokens?, ... }
   * @returns {Promise<{ response: Response, abort: () => void }>}
   *
   * For stream=true, the response body is a ReadableStream of SSE lines.
   * For stream=false, the response body is JSON after decryption.
   */
  async chat(params, onStreamChunk = null) {
    const model = params.model;
    if (!model) throw new Error('Missing "model" in chat params');

    const stream = Boolean(params.stream);
    const chuteId = await this._discovery.resolveChuteId(model);
    const instance = await this._discovery.getNonce(chuteId);

    const { blob, responseSk } = await buildE2EERequest(instance.e2ePubkey, params);

    const invokeUrl = `${this._apiBase}/e2e/invoke`;
    const controller = new AbortController();

    const invokeRes = await fetch(invokeUrl, {
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
    });

    if (!invokeRes.ok) {
      const text = await invokeRes.text().catch(() => '');
      throw new Error(`Chutes E2EE invoke failed: ${invokeRes.status} ${invokeRes.statusText} — ${text}`);
    }

    if (stream) {
      const body = this._decorateStream(invokeRes.body, responseSk);
      return {
        response: new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
        abort: () => controller.abort(),
      };
    }

    const bodyBuffer = Buffer.from(await invokeRes.arrayBuffer());
    const decrypted = await decryptResponse(bodyBuffer, responseSk);
    return {
      response: new Response(JSON.stringify(decrypted), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      abort: () => {},
    };
  }

  _decorateStream(rawBody, responseSk) {
    const reader = rawBody.getReader();
    let streamKey = null;
    let buffer = '';
    const decoder = new TextDecoder();

    return new ReadableStream({
      start(controller) {
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                const result = await processSSELineAsync(line, responseSk, streamKey);
                if (result) {
                  if (result.type === 'stream_key') {
                    streamKey = result.key;
                  } else if (result.type === 'chunk') {
                    controller.enqueue(new TextEncoder().encode(result.data));
                  } else if (result.type === 'done') {
                    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                  }
                }
              }
            }

            if (buffer.trim()) {
              const result = await processSSELineAsync(buffer, responseSk, streamKey);
              if (result && result.type === 'chunk') {
                controller.enqueue(new TextEncoder().encode(result.data));
              }
            }

            controller.close();
          } catch (err) {
            controller.error(err);
          }
        };
        pump();
      },
      cancel() {
        reader.cancel();
      },
    });
  }
}

async function processSSELineAsync(line, responseSk, currentStreamKey) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data: ')) return null;

  const raw = trimmed.slice(6).trim();
  if (raw === '[DONE]') return { type: 'done' };
  if (!raw) return null;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }

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
    const errorData = JSON.stringify({ error: event.e2e_error });
    return { type: 'chunk', data: `data: ${errorData}\n\n` };
  }

  return null;
}

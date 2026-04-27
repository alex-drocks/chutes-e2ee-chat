/**
 * CORS verification test for Electron/Node.js E2EE transport.
 *
 * In a browser, Chutes.ai CORS blocks requests with custom E2EE headers
 * (X-Chute-Id, X-Instance-Id, X-E2E-Nonce, etc.) because the server
 * returns a static Access-Control-Allow-Headers whitelist that doesn't
 * include them. The preflight OPTIONS fails and the browser cancels the
 * actual request.
 *
 * In Electron's Node.js main process, fetch() is NOT subject to CORS.
 * This test verifies that:
 *   1. Model discovery works without any CORS errors
 *   2. Instance discovery with custom headers works
 *   3. The /e2e/invoke endpoint accepts our encrypted blobs
 *   4. Custom headers reach the server successfully
 *
 * This validates WHY Electron (not a browser) is the right choice for
 * a Chutes E2EE client.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';

import { ChutesE2EETransport } from '../lib/chutes/ChutesE2EETransport.js';

const API_KEY = process.env.CHUTES_API_KEY;
const SKIP = !API_KEY;

describe('CORS-Free Node.js E2EE Transport', { skip: SKIP }, () => {
  const NON_REASONING_MODEL = 'Qwen/Qwen3-32B-TEE';

  it('should fetch /v1/models without any CORS preflight errors', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    // getModels() does a simple GET with Authorization header only
    const models = await transport.getModels();
    assert.ok(models.length >= 5, `expected >= 5 models, got ${models.length}`);
    const teeModels = models.filter((m) => m.includes('-TEE'));
    assert.ok(teeModels.length >= 3, `expected >= 3 TEE models, got ${teeModels.length}`);
    console.log('  TEE models:', teeModels.length);
  });

  it('should fetch /e2e/instances with custom headers (no CORS)', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const chuteId = await transport._discovery.resolveChuteId(NON_REASONING_MODEL);
    const instance = await transport._discovery.getNonce(chuteId);

    assert.ok(instance.instanceId, 'instanceId should be present');
    assert.ok(instance.e2ePubkey, 'e2ePubkey should be present');
    assert.ok(instance.nonce, 'nonce should be present');
    console.log('  instanceId:', instance.instanceId.slice(0, 8) + '...');
  });

  it('should POST /e2e/invoke with custom E2EE headers (no CORS)', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const { response } = await transport.chat({
      model: NON_REASONING_MODEL,
      messages: [{ role: 'user', content: 'Say exactly "cors free"' }],
      stream: false,
      max_tokens: 10,
    });

    assert.strictEqual(response.status, 200, `unexpected status: ${response.status}`);
    const body = await response.json();
    const text = body.choices?.[0]?.message?.content || '';
    assert.ok(text.length > 2, 'expected non-empty text response');
    assert.ok(typeof text === 'string', 'response should be a string');
    console.log('  Response:', text.slice(0, 60));
  });

  it('should prove Node.js fetch ignores CORS entirely', async () => {
    // In a browser, this exact request would fail CORS preflight because:
    // - Content-Type: application/octet-stream is not a simple CORS content-type
    // - Custom headers (X-Chute-Id, X-Instance-Id, etc.) are not whitelisted
    // - The server returns a static Access-Control-Allow-Headers list that
    //   does NOT include any of the X-E2E-* or X-Chute-* headers
    //
    // Node.js fetch() has no CORS enforcement at all — it's just an HTTP client.

    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const chuteId = await transport._discovery.resolveChuteId(NON_REASONING_MODEL);
    const instance = await transport._discovery.getNonce(chuteId);

    // Manually replicate the invoke request headers to verify they reach the server
    const invokeUrl = 'https://api.chutes.ai/e2e/invoke';
    const { blob } = await import('../lib/chutes/ChutesE2EECrypto.js').then((m) =>
      m.buildE2EERequest(instance.e2ePubkey, {
        model: NON_REASONING_MODEL,
        messages: [{ role: 'user', content: 'CORS test' }],
        stream: false,
        max_tokens: 5,
      }),
    );

    const res = await fetch(invokeUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'X-Chute-Id': chuteId,
        'X-Instance-Id': instance.instanceId,
        'X-E2E-Nonce': instance.nonce,
        'X-E2E-Stream': 'false',
        'X-E2E-Path': '/v1/chat/completions',
        'Content-Type': 'application/octet-stream',
        // In a browser, the presence of these headers would trigger a preflight
        // that would FAIL because they are not in the server's CORS whitelist.
        // In Node.js, they just go through as HTTP headers.
      },
      body: blob,
    });

    assert.strictEqual(res.status, 200, `invoke should succeed; got ${res.status}`);
    console.log('  CORS-free invoke succeeded with all custom headers');
  });
});

if (SKIP) {
  console.log('Skipped CORS tests — set CHUTES_API_KEY to verify CORS-free Node.js transport.');
}

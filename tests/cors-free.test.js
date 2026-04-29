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
 *
 * Usage:
 *   RUN_LIVE_TESTS=1 CHUTES_API_KEY=*** bun test tests/cors-free.test.js
 */

import assert from 'node:assert/strict';

import {
  API_KEY,
  assertReadableText,
  describeSelectedModel,
  getLiveContext,
  liveTest,
} from './live-chutes.js';

liveTest('(live) should fetch /v1/models without any CORS preflight errors', async () => {
  const ctx = await getLiveContext();
  const { transport } = ctx;
  const models = await transport.getModels();
  assert.ok(models.length >= 1, `expected >= 1 model, got ${models.length}`);
  const teeModels = models.filter((m) => m.includes('-TEE'));
  assert.ok(teeModels.length >= 1, `expected >= 1 TEE model, got ${teeModels.length}`);
  console.log(`  TEE models: ${teeModels.length}; selected ${describeSelectedModel(ctx)}`);
});

liveTest('(live) should fetch /e2e/instances with custom headers (no CORS)', async () => {
  const { transport, chuteId } = await getLiveContext();
  const instance = await transport._discovery.getNonce(chuteId);

  assert.ok(instance.instanceId, 'instanceId should be present');
  assert.ok(instance.e2ePubkey, 'e2ePubkey should be present');
  assert.ok(instance.nonce, 'nonce should be present');
  console.log('  instanceId:', instance.instanceId.slice(0, 8) + '...');
});

liveTest('(live) should POST /e2e/invoke with custom E2EE headers (no CORS)', async () => {
  const { transport, model } = await getLiveContext();
  const { response } = await transport.chat({
    model,
    messages: [{ role: 'user', content: 'Reply with a short CORS-free confirmation.' }],
    stream: false,
    max_tokens: 24,
  });

  assert.strictEqual(response.status, 200, `unexpected status: ${response.status}`);
  const body = await response.json();
  const msg = body.choices?.[0]?.message;
  const text = msg?.content || msg?.reasoning_content || '';
  assertReadableText(text, 'CORS-free response');
  console.log('  Response:', text.slice(0, 60));
});

liveTest('(live) should prove Node.js fetch ignores CORS entirely', async () => {
  // In a browser, this exact request would fail CORS preflight because:
  // - Content-Type: application/octet-stream is not a simple CORS content-type
  // - Custom headers (X-Chute-Id, X-Instance-Id, etc.) are not whitelisted
  // - The server returns a static Access-Control-Allow-Headers list that
  //   does NOT include any of the X-E2E-* or X-Chute-* headers
  //
  // Node.js fetch() has no CORS enforcement at all — it's just an HTTP client.

  const { transport, model, chuteId } = await getLiveContext();
  const instance = await transport._discovery.getNonce(chuteId);

  // Manually replicate the invoke request headers to verify they reach the server
  const invokeUrl = 'https://api.chutes.ai/e2e/invoke';
  const { buildE2EERequest } = await import('../lib/chutes/ChutesE2EECrypto.js');
  const { blob } = await buildE2EERequest(instance.e2ePubkey, {
    model,
    messages: [{ role: 'user', content: 'CORS test' }],
    stream: false,
    max_tokens: 8,
  });

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

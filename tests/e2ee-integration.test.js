/**
 * Standalone E2EE integration test.
 *
 * Tests the Node.js E2EE transport directly — no Electron needed.
 *
 * Usage:
 *   RUN_LIVE_TESTS=1 CHUTES_API_KEY=*** bun test tests/e2ee-integration.test.js
 */

import assert from 'node:assert/strict';

import {
  assertReadableText,
  describeSelectedModel,
  getLiveContext,
  liveTest,
  readSseChunks,
} from './live-chutes.js';

liveTest('(live) should discover and select an available TEE model', async () => {
  const ctx = await getLiveContext();
  assert.ok(ctx.teeModels.length > 0, 'expected at least one reasoning-capable TEE text model');
  assert.ok(ctx.viableModels.length > 0, 'expected at least one TEE model below live-test utilization thresholds');
  console.log(`  TEE models: ${ctx.teeModels.length}; viable: ${ctx.viableModels.length}; using ${describeSelectedModel(ctx)}`);
});

liveTest('(live) should complete a non-streaming chat completion', async () => {
  const { transport, model } = await getLiveContext();
  const { response } = await transport.chat({
    model,
    messages: [{ role: 'user', content: 'Reply with a short confirmation that encryption works.' }],
    stream: false,
    max_tokens: 24,
  });

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  const msg = body.choices?.[0]?.message;
  const text = msg?.content || msg?.reasoning_content || '';
  assertReadableText(text, 'non-streaming response');
  console.log('  Non-streaming response:', text.slice(0, 60));
});

liveTest('(live) should stream a chat completion with valid SSE chunks', async () => {
  const { transport, model } = await getLiveContext();
  const { response } = await transport.chat({
    model,
    messages: [{ role: 'user', content: 'Reply with a very short greeting.' }],
    stream: true,
    max_tokens: 24,
  });

  assert.strictEqual(response.status, 200);
  const ct = response.headers.get('content-type');
  assert.ok(ct?.includes('text/event-stream'), `expected SSE, got ${ct}`);

  const { dataLines, contentChunks, fullText } = await readSseChunks(response, {
    maxReads: 20,
    stopAfterDataLines: 8,
  });
  assert.ok(dataLines > 0, 'expected at least one SSE data line');
  assert.ok(contentChunks > 0, 'expected at least one SSE content chunk');
  assertReadableText(fullText, 'streaming response');
  console.log(`  Streaming chunks received: ${dataLines}; text: ${fullText.slice(0, 60)}`);
});

liveTest('(live) should handle the selected reasoning-capable model', async () => {
  const { transport, model } = await getLiveContext();
  const { response } = await transport.chat({
    model,
    messages: [{ role: 'user', content: 'Confirm E2EE works in one short sentence.' }],
    stream: false,
    max_tokens: 32,
  });

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  const msg = body.choices?.[0]?.message;
  const text = msg?.content || msg?.reasoning_content;
  assert.ok(text, 'neither content nor reasoning_content present');
  assertReadableText(text, 'reasoning response');
  console.log('  Reasoning model response:', text.slice(0, 60));
});

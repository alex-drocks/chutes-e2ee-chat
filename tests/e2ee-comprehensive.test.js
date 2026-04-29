/**
 * Comprehensive E2EE confidence tests — the full pipeline end-to-end.
 *
 * These tests build very high confidence that every layer of the E2EE
 * transport works correctly against live Chutes.ai TEE instances.
 *
 * Usage:
 *   RUN_LIVE_TESTS=1 CHUTES_API_KEY=*** bun test tests/e2ee-comprehensive.test.js
 */

import assert from 'node:assert/strict';

import { buildE2EERequest, decryptResponse } from '../lib/chutes/ChutesE2EECrypto.js';
import {
  API_KEY,
  assertReadableText,
  describeSelectedModel,
  getLiveContext,
  liveTest,
  readSseChunks,
} from './live-chutes.js';

// Re-use a single utilization-selected context across all tests to reduce API pressure.
let liveContext;

async function getContext() {
  if (!liveContext) {
    liveContext = await getLiveContext();
  }
  return liveContext;
}

async function getTransport() {
  return (await getContext()).transport;
}

async function getModel() {
  return (await getContext()).model;
}

async function getChuteId() {
  return (await getContext()).chuteId;
}

liveTest('(live) warmup: initialise shared transport', async () => {
  const ctx = await getContext();
  assert.ok(ctx.model, 'live context must select a model');
  console.log(`  Comprehensive tests using ${describeSelectedModel(ctx)}`);
});

liveTest('(live) should discover TEE models and resolve the selected chute ID', async () => {
  const ctx = await getContext();
  assert.ok(ctx.teeModels.length >= 1, `expected >= 1 TEE model, got ${ctx.teeModels.length}`);
  assert.ok(ctx.viableModels.length >= 1, `expected >= 1 utilization-eligible model, got ${ctx.viableModels.length}`);
  assert.ok(ctx.chuteId.includes('-'), `chute_id should look like a UUID: ${ctx.chuteId}`);
  console.log(`  Discovered ${ctx.teeModels.length} TEE models; selected ${describeSelectedModel(ctx)}`);
});

// ---------------------------------------------------------------------------
// Layer 2: Instance discovery returns valid crypto material
// ---------------------------------------------------------------------------

liveTest('(live) should return a 1184-byte e2e_pubkey after base64 decode', async () => {
  const t = await getTransport();
  const chuteId = await getChuteId();
  const inst = await t._discovery.getNonce(chuteId);
  const pubkey = Buffer.from(inst.e2ePubkey, 'base64');
  assert.strictEqual(pubkey.length, 1184, 'e2e_pubkey must be exactly 1184 bytes');
  assert.ok(!pubkey.equals(Buffer.alloc(1184)), 'pubkey must not be all zeros');
  assert.ok(inst.nonce.length > 0, 'nonce must not be empty');
  console.log(`  pubkey: ${pubkey.length} bytes, nonce: ${inst.nonce.slice(0, 12)}...`);
});

// ---------------------------------------------------------------------------
// Layer 3: Encrypted request blob format and plaintext secrecy
// ---------------------------------------------------------------------------

liveTest('(live) should build a correctly sized encrypted blob with no plaintext leakage', async () => {
  const t = await getTransport();
  const chuteId = await getChuteId();
  const inst = await t._discovery.getNonce(chuteId);
  const model = await getModel();
  const prompt = 'What is the capital of France? ANSWER_WITH_ONE_WORD';
  const payload = { model, messages: [{ role: 'user', content: prompt }] };
  const { blob, responseSk } = await buildE2EERequest(inst.e2ePubkey, payload);

  // Blob: ML-KEM ct (1088) + nonce (12) + ciphertext (N) + tag (16)
  const CT_SIZE = 1088;
  const NONCE_SIZE = 12;
  const TAG_SIZE = 16;
  assert.ok(blob.length > CT_SIZE + NONCE_SIZE + TAG_SIZE, 'blob too small');

  const mlkemCt = blob.slice(0, CT_SIZE);
  const nonce = blob.slice(CT_SIZE, CT_SIZE + NONCE_SIZE);
  const tag = blob.slice(-TAG_SIZE);
  const ciphertext = blob.slice(CT_SIZE + NONCE_SIZE, -TAG_SIZE);

  assert.strictEqual(mlkemCt.length, CT_SIZE);
  assert.strictEqual(nonce.length, NONCE_SIZE);
  assert.strictEqual(tag.length, TAG_SIZE);
  assert.ok(ciphertext.length > 0);

  // Security: prompt must NOT appear anywhere
  const asBinary = blob.toString('binary');
  assert.ok(!asBinary.includes(prompt), 'SECURITY: prompt found in plaintext blob');
  assert.ok(!blob.includes(Buffer.from(prompt)), 'SECURITY: prompt bytes found in blob');
  assert.ok(!asBinary.includes('capital of France'), 'SECURITY: partial prompt leaked');
  assert.strictEqual(responseSk.length, 2400, 'responseSk must be 2400 bytes');

  console.log(`  blob: ${blob.length} bytes, ct: ${ciphertext.length}, prompt hidden: ✅`);
});

// ---------------------------------------------------------------------------
// Layer 4: Forward secrecy — each request gets unique ephemeral keys
// ---------------------------------------------------------------------------

liveTest('(live) should produce different encrypted blobs for identical payloads', async () => {
  const t = await getTransport();
  const chuteId = await getChuteId();
  const inst = await t._discovery.getNonce(chuteId);
  const model = await getModel();
  const payload = { model, messages: [{ role: 'user', content: 'test' }] };
  const { blob: blob1 } = await buildE2EERequest(inst.e2ePubkey, payload);
  const { blob: blob2 } = await buildE2EERequest(inst.e2ePubkey, payload);

  assert.ok(!blob1.equals(blob2), 'identical payloads must produce different blobs (forward secrecy)');
  assert.ok(!blob1.slice(0, 1088).equals(blob2.slice(0, 1088)), 'ML-KEM ct must differ');

  console.log(`  blob1: ${blob1.length}, blob2: ${blob2.length}, unique: ✅`);
});

// ---------------------------------------------------------------------------
// Layer 5: Non-streaming E2EE round-trip with readable response
// ---------------------------------------------------------------------------

liveTest('(live) should complete non-streaming E2EE chat and return readable text', async () => {
  const t = await getTransport();
  const model = await getModel();
  const { response } = await t.chat({
    model,
    messages: [{ role: 'user', content: 'Reply with one short sentence about secure chat.' }],
    stream: false,
    max_tokens: 24,
  });

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.ok(body.choices, 'response must have choices');
  const msg = body.choices[0]?.message;
  const text = msg?.content || msg?.reasoning_content || '';

  assertReadableText(text, 'chat response');

  console.log(`  Response: "${text.slice(0, 60)}..."`);
});

// ---------------------------------------------------------------------------
// Layer 6: Streaming E2EE round-trip with accumulated readable text
// ---------------------------------------------------------------------------

liveTest('(live) should stream E2EE chat and accumulate human-readable text', async () => {
  const t = await getTransport();
  const model = await getModel();
  const { response } = await t.chat({
    model,
    messages: [{ role: 'user', content: 'Reply with a short sentence about encryption.' }],
    stream: true,
    max_tokens: 24,
  });

  assert.strictEqual(response.status, 200);
  const ct = response.headers.get('content-type');
  assert.ok(ct?.includes('text/event-stream'), `expected SSE, got ${ct}`);

  const { contentChunks: chunkCount, fullText } = await readSseChunks(response, {
    maxReads: 30,
    stopAfterDataLines: 10,
  });

  assert.ok(chunkCount >= 1, `expected >= 1 content chunk, got ${chunkCount}`);
  assertReadableText(fullText, 'streamed text');

  console.log(`  Streamed ${chunkCount} chunks, text: "${fullText.slice(0, 60)}..."`);
});

// ---------------------------------------------------------------------------
// Layer 7: Reasoning model with reasoning_content field
// ---------------------------------------------------------------------------

liveTest('(live) should handle the selected reasoning-capable model', async () => {
  const t = await getTransport();
  const model = await getModel();
  const { response } = await t.chat({
    model,
    messages: [{ role: 'user', content: 'Explain why 2+2=4 in one short sentence.' }],
    stream: false,
    max_tokens: 40,
  });

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  const msg = body.choices?.[0]?.message;
  assert.ok(msg, 'message must exist');

  const text = msg.content || msg.reasoning_content || '';
  assertReadableText(text, 'reasoning response');

  console.log(`  Reasoning text: "${text.slice(0, 60)}..."`);
});

// ---------------------------------------------------------------------------
// Layer 8: The response blob is actually encrypted, not plaintext JSON
// ---------------------------------------------------------------------------

liveTest('(live) should confirm the raw response is encrypted binary, not plaintext JSON', async () => {
  const t = await getTransport();
  const chuteId = await getChuteId();
  const inst = await t._discovery.getNonce(chuteId);
  const model = await getModel();

  const payload = { model, messages: [{ role: 'user', content: 'Hi' }], stream: false, max_tokens: 8 };
  const { blob, responseSk } = await buildE2EERequest(inst.e2ePubkey, payload);

  const invokeUrl = 'https://api.chutes.ai/e2e/invoke';
  const raw = await fetch(invokeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'X-Chute-Id': chuteId,
      'X-Instance-Id': inst.instanceId,
      'X-E2E-Nonce': inst.nonce,
      'X-E2E-Stream': 'false',
      'X-E2E-Path': '/v1/chat/completions',
      'Content-Type': 'application/octet-stream',
    },
    body: blob,
  });

  assert.strictEqual(raw.status, 200);
  const rawBuffer = Buffer.from(await raw.arrayBuffer());

  let isPlaintextJson = false;
  try {
    JSON.parse(rawBuffer.toString('utf-8'));
    isPlaintextJson = true;
  } catch {
    // expected
  }
  assert.ok(!isPlaintextJson, 'raw response must NOT be plaintext JSON');

  const decrypted = await decryptResponse(rawBuffer, responseSk);
  assert.ok(decrypted.choices, 'decrypted response must have choices');
  const msg = decrypted.choices[0]?.message;
  const text = msg?.content || msg?.reasoning_content || '';
  assertReadableText(text, 'decrypted response text');

  console.log(`  Raw ${rawBuffer.length} bytes (encrypted) → decrypted: "${text.slice(0, 40)}..."`);
});

// ---------------------------------------------------------------------------
// Layer 9: Error handling — bad model name
// ---------------------------------------------------------------------------

liveTest('(live) should fail gracefully with an invalid model name', async () => {
  const t = await getTransport();
  try {
    await t.chat({
      model: 'totally-fake-model-name/123456789',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    assert.fail('expected an error for invalid model');
  } catch (err) {
    assert.ok(
      err.message.includes('Could not resolve') ||
      err.message.includes('not found') ||
      err.code === 'MODEL_NOT_FOUND',
      `unexpected error: ${err.message}`,
    );
  }
  console.log('  Invalid model correctly rejected');
});

// ---------------------------------------------------------------------------
// Layer 10: UUID model passthrough
// ---------------------------------------------------------------------------

liveTest('(live) should accept a UUID directly as model name', async () => {
  const t = await getTransport();
  const chuteId = await getChuteId();
  const resolved = await t._discovery.resolveChuteId(chuteId);
  assert.strictEqual(resolved, chuteId, 'UUID should pass through unchanged');
  console.log(`  UUID passthrough: ${chuteId.slice(0, 8)}... ✅`);
});

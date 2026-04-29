/**
 * Stress and regression tests for E2EE transport edge cases.
 *
 * Usage:
 *   node tests/e2ee-stress.test.js            # runs pure-crypto regressions only
 *   RUN_LIVE_TESTS=1 CHUTES_API_KEY=*** bun test tests/e2ee-stress.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveKey,
  chachaEncrypt,
  chachaDecrypt,
  buildE2EERequest,
  generateKeyPair,
  encapsulate,
} from '../lib/chutes/ChutesE2EECrypto.js';
import {
  assertReadableText,
  describeSelectedModel,
  getLiveContext,
  liveTest,
} from './live-chutes.js';

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

// ---------------------------------------------------------------------------
// Regression: Node.js v22 ArrayBuffer bug in hkdfSync
// ---------------------------------------------------------------------------

test('should produce a real Buffer from deriveKey (v22 regression)', () => {
  const key = deriveKey(
    Buffer.alloc(32, 0xab),
    Buffer.alloc(1088, 0xcd),
    Buffer.from('e2e-req-v1')
  );

  // @stablelib/chacha20poly1305 checks instanceof Uint8Array
  // Node.js v22+ returns ArrayBuffer from hkdfSync; we wrap in Buffer.from()
  assert.ok(key instanceof Uint8Array, 'key must pass instanceof Uint8Array');
  assert.strictEqual(key.length, 32);
  // Must not throw when passing directly to ChaCha20Poly1305
  const nonce = Buffer.alloc(12);
  const { ciphertext, tag } = chachaEncrypt(key, nonce, Buffer.from('test'));
  assert.ok(ciphertext.length > 0);
  assert.strictEqual(tag.length, 16);
});

// ---------------------------------------------------------------------------
// Regression: Uint8Array.toString('utf-8') comma-separated decimals
// ---------------------------------------------------------------------------

test('should decrypt to real UTF-8 string, not ASCII codes (v22 regression)', () => {
  const key = Buffer.alloc(32, 0x11);
  const nonce = Buffer.alloc(12, 0x22);
  const plaintext = Buffer.from('End-to-end encryption 🔐');

  const { ciphertext, tag } = chachaEncrypt(key, nonce, plaintext);
  const decrypted = chachaDecrypt(key, nonce, ciphertext, tag);
  const str = Buffer.from(decrypted).toString('utf-8');

  assert.strictEqual(str, 'End-to-end encryption 🔐');
  assert.ok(str.includes('encryption'), 'must contain readable word');
  assert.ok(!str.includes('69,110,100'), 'must NOT be decimal ASCII codes');
});

// ---------------------------------------------------------------------------
// Live tests: require CHUTES_API_KEY + RUN_LIVE_TESTS=1
// ---------------------------------------------------------------------------

liveTest('(live) warmup: initialise shared transport', async () => {
  const ctx = await getContext();
  assert.ok(ctx.model, 'live context must select a model');
  console.log(`  Stress tests using ${describeSelectedModel(ctx)}`);
});

// ---------------------------------------------------------------------------
// Stress: long prompt (4KB)
// ---------------------------------------------------------------------------

liveTest('(live) should encrypt and send a 4KB prompt without leaking it', async () => {
  const t = await getTransport();
  const chuteId = await getChuteId();
  const inst = await t._discovery.getNonce(chuteId);
  const model = await getModel();

  const longPrompt = 'A'.repeat(4096);
  const payload = { model, messages: [{ role: 'user', content: longPrompt }] };
  const { blob } = await buildE2EERequest(inst.e2ePubkey, payload);

  assert.ok(blob.length > 1200, 'blob must still be reasonable size');
  assert.ok(!blob.includes(Buffer.from('A'.repeat(100))), 'must not leak long A-run');
  console.log(`  4KB prompt → blob: ${blob.length} bytes, no leakage: ✅`);
});

// ---------------------------------------------------------------------------
// Stress: Unicode / emoji payload
// ---------------------------------------------------------------------------

liveTest('(live) should handle emoji and unicode in prompts', async () => {
  const t = await getTransport();
  const chuteId = await getChuteId();
  const inst = await t._discovery.getNonce(chuteId);
  const model = await getModel();

  const prompt = 'Describe 🔐🛡️🚀 in three emoji';
  const payload = { model, messages: [{ role: 'user', content: prompt }] };
  const { blob } = await buildE2EERequest(inst.e2ePubkey, payload);

  assert.ok(blob.length > 1200);
  assert.ok(!blob.includes(Buffer.from('🔐')), 'emoji must not appear in raw blob');
  assert.ok(!blob.includes(Buffer.from('🚀')), 'emoji must not appear in raw blob');

  console.log(`  Emoji prompt → blob: ${blob.length} bytes, emoji hidden: ✅`);
});

// ---------------------------------------------------------------------------
// Stress: special characters and JSON injection
// ---------------------------------------------------------------------------

liveTest('(live) should handle JSON special characters without breaking payload', async () => {
  const t = await getTransport();
  const chuteId = await getChuteId();
  const inst = await t._discovery.getNonce(chuteId);
  const model = await getModel();

  const prompt = '{"dangerous": "injection", "nested": {"key": "value"}}';
  const payload = { model, messages: [{ role: 'user', content: prompt }] };

  // Must not throw during stringify/encrypt
  const { blob } = await buildE2EERequest(inst.e2ePubkey, payload);
  assert.ok(blob.length > 1200);
  assert.ok(!blob.includes(Buffer.from('dangerous')), 'JSON must be encrypted, not plaintext');

  console.log(`  JSON payload → blob: ${blob.length} bytes, escaped safely: ✅`);
});

// ---------------------------------------------------------------------------
// Stress: conversation history accumulation
// ---------------------------------------------------------------------------

liveTest('(live) should handle multi-turn conversation with growing history', async () => {
  const t = await getTransport();
  const model = await getModel();
  const history = [];
  for (let i = 0; i < 3; i++) {
    history.push({ role: 'user', content: `Message ${i + 1}` });
    history.push({ role: 'assistant', content: `Reply ${i + 1}` });
  }
  history.push({ role: 'user', content: 'What is the last message number? Reply with one digit.' });

  const { response } = await t.chat({
    model,
    messages: history,
    stream: false,
    max_tokens: 18,
  });

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  const msg = body.choices?.[0]?.message;
  const text = msg?.content || msg?.reasoning_content || '';
  assertReadableText(text, 'multi-turn response');

  console.log(`  5-turn conversation → response: "${text.slice(0, 40)}..." ✅`);
});

// ---------------------------------------------------------------------------
// Stress: multiple sequential requests reuse transport
// ---------------------------------------------------------------------------

liveTest('(live) should support multiple sequential requests on same transport', async () => {
  const t = await getTransport();
  const model = await getModel();
  for (let i = 0; i < 3; i++) {
    const { response } = await t.chat({
      model,
      messages: [{ role: 'user', content: `Reply with a short word for request ${i + 1}.` }],
      stream: false,
      max_tokens: 12,
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    const msg = body.choices?.[0]?.message;
    const text = msg?.content || msg?.reasoning_content || '';
    assertReadableText(text, `request ${i + 1} response`);
  }
  console.log('  3 sequential requests on shared transport: ✅');
});

// ---------------------------------------------------------------------------
// Stress: abort streaming mid-flight
// ---------------------------------------------------------------------------

liveTest('(live) should abort a streaming request mid-flight', async () => {
  const t = await getTransport();
  const model = await getModel();
  const { response, abort } = await t.chat({
    model,
    messages: [{ role: 'user', content: 'Write five concise sentences about encrypted chat.' }],
    stream: true,
    max_tokens: 120,
  });

  assert.strictEqual(response.status, 200);

  const reader = response.body.getReader();
  let chunks = 0;
  try {
    for (let i = 0; i < 3; i++) {
      const { done } = await readStreamChunk(reader);
      if (done) break;
      chunks++;
    }
    abort();
    assert.ok(chunks >= 1, `expected at least 1 chunk before abort, got ${chunks}`);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  console.log(`  Aborted after ${chunks} chunks: ✅`);
});

// ---------------------------------------------------------------------------
// Regression: ML-KEM unique encapsulations per call
// ---------------------------------------------------------------------------

test('should never reuse ephemeral keys (ML-KEM forward secrecy)', async () => {
  const { pk } = await generateKeyPair();
  const cts = new Set();
  for (let i = 0; i < 5; i++) {
    const { ct } = await encapsulate(pk);
    const hex = ct.toString('hex');
    assert.ok(!cts.has(hex), `duplicate ciphertext at iteration ${i + 1}`);
    cts.add(hex);
  }
  console.log(`  5 unique encapsulations: ✅`);
});

function readStreamChunk(reader) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Timed out waiting for stream data before abort.'));
    }, 12_000);

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

/**
 * Stress and regression tests for E2EE transport edge cases.
 *
 * Usage:
 *   node tests/e2ee-stress.test.js            # runs pure-crypto regressions only
 *   RUN_LIVE_TESTS=1 CHUTES_API_KEY=*** node tests/e2ee-stress.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';

import {
  deriveKey,
  chachaEncrypt,
  chachaDecrypt,
  buildE2EERequest,
  generateKeyPair,
  encapsulate,
} from '../lib/chutes/ChutesE2EECrypto.js';
import { ChutesE2EETransport } from '../lib/chutes/ChutesE2EETransport.js';

const API_KEY = process.env.CHUTES_API_KEY || '';
const ENABLED = process.env.RUN_LIVE_TESTS === '1';
const FAST_MODEL = 'Qwen/Qwen3-32B-TEE';

let transport;
async function getTransport() {
  if (!transport) {
    transport = new ChutesE2EETransport({ apiKey: API_KEY });
    assert.ok((await transport.getModels()).length > 0);
  }
  return transport;
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

test('(live) warmup: initialise shared transport', async () => {
  if (!ENABLED) {
    console.log('Skipped stress/regression API tests — set CHUTES_API_KEY and RUN_LIVE_TESTS=1.');
    return;
  }
  await getTransport();
});

// ---------------------------------------------------------------------------
// Stress: long prompt (4KB)
// ---------------------------------------------------------------------------

test('(live) should encrypt and send a 4KB prompt without leaking it', async () => {
  if (!ENABLED) return;
  const t = await getTransport();
  const chuteId = await t._discovery.resolveChuteId(FAST_MODEL);
  const inst = await t._discovery.getNonce(chuteId);

  const longPrompt = 'A'.repeat(4096);
  const payload = { model: FAST_MODEL, messages: [{ role: 'user', content: longPrompt }] };
  const { blob } = await buildE2EERequest(inst.e2ePubkey, payload);

  assert.ok(blob.length > 1200, 'blob must still be reasonable size');
  assert.ok(!blob.includes(Buffer.from('A'.repeat(100))), 'must not leak long A-run');
  console.log(`  4KB prompt → blob: ${blob.length} bytes, no leakage: ✅`);
});

// ---------------------------------------------------------------------------
// Stress: Unicode / emoji payload
// ---------------------------------------------------------------------------

test('(live) should handle emoji and unicode in prompts', async () => {
  if (!ENABLED) return;
  const t = await getTransport();
  const chuteId = await t._discovery.resolveChuteId(FAST_MODEL);
  const inst = await t._discovery.getNonce(chuteId);

  const prompt = 'Describe 🔐🛡️🚀 in three emoji';
  const payload = { model: FAST_MODEL, messages: [{ role: 'user', content: prompt }] };
  const { blob } = await buildE2EERequest(inst.e2ePubkey, payload);

  assert.ok(blob.length > 1200);
  assert.ok(!blob.includes(Buffer.from('🔐')), 'emoji must not appear in raw blob');
  assert.ok(!blob.includes(Buffer.from('🚀')), 'emoji must not appear in raw blob');

  console.log(`  Emoji prompt → blob: ${blob.length} bytes, emoji hidden: ✅`);
});

// ---------------------------------------------------------------------------
// Stress: special characters and JSON injection
// ---------------------------------------------------------------------------

test('(live) should handle JSON special characters without breaking payload', async () => {
  if (!ENABLED) return;
  const t = await getTransport();
  const chuteId = await t._discovery.resolveChuteId(FAST_MODEL);
  const inst = await t._discovery.getNonce(chuteId);

  const prompt = '{"dangerous": "injection", "nested": {"key": "value"}}';
  const payload = { model: FAST_MODEL, messages: [{ role: 'user', content: prompt }] };

  // Must not throw during stringify/encrypt
  const { blob } = await buildE2EERequest(inst.e2ePubkey, payload);
  assert.ok(blob.length > 1200);
  assert.ok(!blob.includes(Buffer.from('dangerous')), 'JSON must be encrypted, not plaintext');

  console.log(`  JSON payload → blob: ${blob.length} bytes, escaped safely: ✅`);
});

// ---------------------------------------------------------------------------
// Stress: conversation history accumulation
// ---------------------------------------------------------------------------

test('(live) should handle multi-turn conversation with growing history', async () => {
  if (!ENABLED) return;
  const t = await getTransport();
  const history = [];
  for (let i = 0; i < 3; i++) {
    history.push({ role: 'user', content: `Message ${i + 1}` });
    history.push({ role: 'assistant', content: `Reply ${i + 1}` });
  }
  history.push({ role: 'user', content: 'What is the last message number? Reply with one digit.' });

  const { response } = await t.chat({
    model: FAST_MODEL,
    messages: history,
    stream: false,
    max_tokens: 10,
  });

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content || '';
  assert.ok(text.length > 0, `expected non-empty response, got: "${text}"`);
  assert.ok(/[a-zA-Z\s]{2,}/.test(text), `expected readable text, got: "${text}"`);

  console.log(`  5-turn conversation → response: "${text.slice(0, 40)}..." ✅`);
});

// ---------------------------------------------------------------------------
// Stress: multiple sequential requests reuse transport
// ---------------------------------------------------------------------------

test('(live) should support multiple sequential requests on same transport', async () => {
  if (!ENABLED) return;
  const t = await getTransport();
  for (let i = 0; i < 3; i++) {
    const { response } = await t.chat({
      model: FAST_MODEL,
      messages: [{ role: 'user', content: `Count: ${i + 1}` }],
      stream: false,
      max_tokens: 5,
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    const text = body.choices?.[0]?.message?.content || '';
    assert.ok(text.length > 0, `request ${i + 1} returned empty text`);
  }
  console.log('  3 sequential requests on shared transport: ✅');
});

// ---------------------------------------------------------------------------
// Stress: abort streaming mid-flight
// ---------------------------------------------------------------------------

test('(live) should abort a streaming request mid-flight', async () => {
  if (!ENABLED) return;
  const t = await getTransport();
  const { response, abort } = await t.chat({
    model: FAST_MODEL,
    messages: [{ role: 'user', content: 'Write a very long story about a dragon.' }],
    stream: true,
    max_tokens: 500,
  });

  assert.strictEqual(response.status, 200);

  const reader = response.body.getReader();
  let chunks = 0;
  for (let i = 0; i < 3; i++) {
    const { done } = await reader.read();
    if (done) break;
    chunks++;
  }
  reader.releaseLock();

  abort();
  assert.ok(chunks >= 1, `expected at least 1 chunk before abort, got ${chunks}`);
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

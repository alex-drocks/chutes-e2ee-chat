/**
 * Comprehensive E2EE confidence tests — the full pipeline end-to-end.
 *
 * These tests build very high confidence that every layer of the E2EE
 * transport works correctly against live Chutes.ai TEE instances.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';

import { buildE2EERequest, decryptResponse, decryptStreamInit, decryptStreamChunk } from '../lib/chutes/ChutesE2EECrypto.js';
import { ChutesE2EETransport } from '../lib/chutes/ChutesE2EETransport.js';

const API_KEY = process.env.CHUTES_API_KEY;
const SKIP = !API_KEY;

const FAST_MODEL = 'Qwen/Qwen3-32B-TEE';
const REASONING_MODEL = 'moonshotai/Kimi-K2.5-TEE';

describe('Comprehensive E2EE Confidence', { skip: SKIP }, () => {

  // ---------------------------------------------------------------------------
  // Layer 1: Model discovery and resolution
  // ---------------------------------------------------------------------------

  it('should discover >= 3 TEE models and resolve chute IDs for them', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const models = await transport.getModels();
    const tee = models.filter((m) => m.includes('-TEE'));
    assert.ok(tee.length >= 3, `expected >= 3 TEE models, got ${tee.length}`);

    // Resolve each one
    for (const m of tee.slice(0, 3)) {
      const chuteId = await transport._discovery.resolveChuteId(m);
      assert.ok(chuteId.includes('-'), `chute_id should look like a UUID: ${chuteId}`);
    }
    console.log(`  Verified ${tee.length} TEE models, resolved 3 chute IDs`);
  });

  // ---------------------------------------------------------------------------
  // Layer 2: Instance discovery returns valid crypto material
  // ---------------------------------------------------------------------------

  it('should return a 1184-byte e2e_pubkey after base64 decode', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const chuteId = await transport._discovery.resolveChuteId(FAST_MODEL);
    const inst = await transport._discovery.getNonce(chuteId);

    const pubkey = Buffer.from(inst.e2ePubkey, 'base64');
    assert.strictEqual(pubkey.length, 1184, 'e2e_pubkey must be exactly 1184 bytes');
    assert.ok(!pubkey.equals(Buffer.alloc(1184)), 'pubkey must not be all zeros');
    assert.ok(inst.nonce.length > 0, 'nonce must not be empty');
    console.log(`  pubkey: ${pubkey.length} bytes, nonce: ${inst.nonce.slice(0, 12)}...`);
  });

  // ---------------------------------------------------------------------------
  // Layer 3: Encrypted request blob format and plaintext secrecy
  // ---------------------------------------------------------------------------

  it('should build a correctly sized encrypted blob with no plaintext leakage', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const chuteId = await transport._discovery.resolveChuteId(FAST_MODEL);
    const inst = await transport._discovery.getNonce(chuteId);

    const prompt = 'What is the capital of France? ANSWER_WITH_ONE_WORD';
    const payload = { model: FAST_MODEL, messages: [{ role: 'user', content: prompt }] };
    const { blob, responseSk } = await buildE2EERequest(inst.e2ePubkey, payload);

    // Blob: ML-KEM ct (1088) + nonce (12) + ciphertext (N) + tag (16)
    const CT_SIZE = 1088;
    const NONCE_SIZE = 12;
    const TAG_SIZE = 16;
    assert.ok(blob.length > CT_SIZE + NONCE_SIZE + TAG_SIZE, 'blob too small');

    // Parse components
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

    // responseSk must be usable for decryption later
    assert.strictEqual(responseSk.length, 2400, 'responseSk must be 2400 bytes');

    console.log(`  blob: ${blob.length} bytes, ct: ${ciphertext.length}, prompt hidden: ✅`);
  });

  // ---------------------------------------------------------------------------
  // Layer 4: Forward secrecy — each request gets unique ephemeral keys
  // ---------------------------------------------------------------------------

  it('should produce different encrypted blobs for identical payloads', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const chuteId = await transport._discovery.resolveChuteId(FAST_MODEL);
    const inst = await transport._discovery.getNonce(chuteId);

    const payload = { model: FAST_MODEL, messages: [{ role: 'user', content: 'test' }] };
    const { blob: blob1 } = await buildE2EERequest(inst.e2ePubkey, payload);
    const { blob: blob2 } = await buildE2EERequest(inst.e2ePubkey, payload);

    assert.ok(!blob1.equals(blob2), 'identical payloads must produce different blobs (forward secrecy)');

    // Even the ML-KEM ciphertext prefix should differ
    assert.ok(!blob1.slice(0, 1088).equals(blob2.slice(0, 1088)), 'ML-KEM ct must differ');

    console.log(`  blob1: ${blob1.length}, blob2: ${blob2.length}, unique: ✅`);
  });

  // ---------------------------------------------------------------------------
  // Layer 5: Non-streaming E2EE round-trip with readable response
  // ---------------------------------------------------------------------------

  it('should complete non-streaming E2EE chat and return coherent English', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const { response } = await transport.chat({
      model: FAST_MODEL,
      messages: [{ role: 'user', content: 'What is 2+2? Answer with one word.' }],
      stream: false,
      max_tokens: 15,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.ok(body.choices, 'response must have choices');

    const msg = body.choices[0]?.message;
    const text = msg?.content || msg?.reasoning_content || '';

    assert.ok(typeof text === 'string', 'text must be a string');
    assert.ok(text.length > 0, 'text must not be empty');
    assert.ok(/four|4|\d/i.test(text), `expected numeric answer, got: ${text}`);

    // Human-readable check: not ASCII codes
    assert.ok(!/^\d+(,\d+)*$/.test(text.trim()), 'must NOT be comma-separated ASCII codes');
    assert.ok(/[a-zA-Z\s]{2,}/.test(text), 'must contain readable alphabetic text');

    console.log(`  Response: "${text.slice(0, 60)}..."`);
  });

  // ---------------------------------------------------------------------------
  // Layer 6: Streaming E2EE round-trip with accumulated readable text
  // ---------------------------------------------------------------------------

  it('should stream E2EE chat and accumulate human-readable text', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const { response } = await transport.chat({
      model: FAST_MODEL,
      messages: [{ role: 'user', content: 'Count to three in English.' }],
      stream: true,
      max_tokens: 20,
    });

    assert.strictEqual(response.status, 200);
    const ct = response.headers.get('content-type');
    assert.ok(ct?.includes('text/event-stream'), `expected SSE, got ${ct}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let chunkCount = 0;

    for (let safety = 0; safety < 30; safety++) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            fullText += content;
            if (content) chunkCount++;
          } catch {
            // ignore parse errors for safety
          }
        }
      }
    }
    reader.releaseLock();

    assert.ok(chunkCount >= 1, `expected >= 1 content chunk, got ${chunkCount}`);
    assert.ok(fullText.length > 3, `expected meaningful text, got: "${fullText}"`);
    assert.ok(/one|two|three|1|2|3/i.test(fullText), `expected counting text, got: "${fullText}"`);
    assert.ok(/[a-zA-Z\s]{2,}/.test(fullText), 'accumulated text must be readable English');

    console.log(`  Streamed ${chunkCount} chunks, text: "${fullText.slice(0, 60)}..."`);
  });

  // ---------------------------------------------------------------------------
  // Layer 7: Reasoning model with reasoning_content field
  // ---------------------------------------------------------------------------

  it('should handle reasoning model (Kimi) returning reasoning_content', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const { response } = await transport.chat({
      model: REASONING_MODEL,
      messages: [{ role: 'user', content: 'Explain why 2+2=4 in one short sentence.' }],
      stream: false,
      max_tokens: 40,
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    const msg = body.choices?.[0]?.message;
    assert.ok(msg, 'message must exist');

    const text = msg.content || msg.reasoning_content || '';
    assert.ok(text.length > 5, `expected non-empty text, got: ${JSON.stringify(msg)}`);
    assert.ok(/[a-zA-Z\s]{5,}/.test(text), 'must contain readable text');

    console.log(`  Reasoning text: "${text.slice(0, 60)}..."`);
  });

  // ---------------------------------------------------------------------------
  // Layer 8: The response blob is actually encrypted, not plaintext JSON
  // ---------------------------------------------------------------------------

  it('should confirm the raw response is encrypted binary, not plaintext JSON', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const chuteId = await transport._discovery.resolveChuteId(FAST_MODEL);
    const inst = await transport._discovery.getNonce(chuteId);

    const payload = { model: FAST_MODEL, messages: [{ role: 'user', content: 'Hi' }], stream: false, max_tokens: 5 };
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

    // Raw response MUST NOT be valid JSON — it's an encrypted binary blob
    let isPlaintextJson = false;
    try {
      JSON.parse(rawBuffer.toString('utf-8'));
      isPlaintextJson = true;
    } catch {
      // expected
    }
    assert.ok(!isPlaintextJson, 'raw response must NOT be plaintext JSON');

    // But decryption should yield valid JSON
    const decrypted = await decryptResponse(rawBuffer, responseSk);
    assert.ok(decrypted.choices, 'decrypted response must have choices');
    const text = decrypted.choices[0]?.message?.content || '';
    assert.ok(text.length > 0, 'decrypted text must not be empty');

    console.log(`  Raw ${rawBuffer.length} bytes (encrypted) → decrypted: "${text.slice(0, 40)}..."`);
  });

  // ---------------------------------------------------------------------------
  // Layer 9: Error handling — bad model name
  // ---------------------------------------------------------------------------

  it('should fail gracefully with an invalid model name', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    try {
      await transport.chat({
        model: 'totally-fake-model-name/123456789',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      });
      assert.fail('expected an error for invalid model');
    } catch (err) {
      assert.ok(err.message.includes('Could not resolve') || err.message.includes('chute_id'), `unexpected error: ${err.message}`);
    }
    console.log('  Invalid model correctly rejected');
  });

  // ---------------------------------------------------------------------------
  // Layer 10: UUID model passthrough
  // ---------------------------------------------------------------------------

  it('should accept a UUID directly as model name', async () => {
    const transport = new ChutesE2EETransport({ apiKey: API_KEY });
    const chuteId = await transport._discovery.resolveChuteId(FAST_MODEL);
    // Pass the UUID as model — should not attempt resolution
    const resolved = await transport._discovery.resolveChuteId(chuteId);
    assert.strictEqual(resolved, chuteId, 'UUID should pass through unchanged');
    console.log(`  UUID passthrough: ${chuteId.slice(0, 8)}... ✅`);
  });

});

if (SKIP) {
  console.log('Skipped comprehensive E2EE tests — set CHUTES_API_KEY.');
}

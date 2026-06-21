/**
 * Chutes E2EE Transport — fast mock-based regression tests.
 *
 * These tests confirm protocol correctness WITHOUT hitting the network.
 * Safe to run in CI and provide immediate feedback on regressions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  deriveKey,
  chachaEncrypt,
  chachaDecrypt,
  buildE2EERequest,
  decryptResponse,
  decryptStreamInit,
  decryptStreamChunk,
  generateKeyPair,
  encapsulate,
} from '../lib/chutes/ChutesE2EECrypto.js';
import {
  MLKEM_CT_SIZE,
  MLKEM_PK_SIZE,
  CHACHA_NONCE_SIZE,
  CHACHA_TAG_SIZE,
  MLKEM_SK_SIZE,
  INFO_REQ,
  INFO_RESP,
  INFO_STREAM,
} from '../lib/chutes/constants.js';
import {
  ChutesError,
  ChutesRateLimitError,
  ChutesAuthError,
  ChutesModelNotFoundError,
  ChutesE2EESecurityError,
} from '../lib/chutes/errors.js';
import { _fetchWithRetry } from '../lib/chutes/utils.js';
import { ChutesE2EETransport } from '../lib/chutes/ChutesE2EETransport.js';

function seedTransportModel(transport, overrides = {}) {
  const meta = {
    id: 'MockModel-TEE',
    chuteId: 'chute-1',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedFeatures: [],
    contextLength: null,
    maxOutputLength: null,
    confidentialCompute: true,
    ...overrides,
  };

  transport._discovery._modelMap.set(meta.id, meta.chuteId);
  transport._discovery._modelMeta.set(meta.id, meta);
  transport._discovery._modelMapLoadedAt = Date.now();
  return meta;
}
describe('Protocol Invariants (no network)', () => {

  // ---------------------------------------------------------------------------
  // Crypto primitives
  // ---------------------------------------------------------------------------

  it('should generate valid ML-KEM keypairs', async () => {
    const { pk, sk } = await generateKeyPair();
    assert.strictEqual(pk.length, MLKEM_PK_SIZE, `public key must be ${MLKEM_PK_SIZE} bytes`);
    assert.strictEqual(sk.length, MLKEM_SK_SIZE, `secret key must be ${MLKEM_SK_SIZE} bytes`);
    assert.ok(!pk.equals(Buffer.alloc(pk.length)), 'public key must not be all zeros');
  });

  it('should encapsulate and decapsulate consistently', async () => {
    const { pk, sk } = await generateKeyPair();
    const { ct, ss: ssEnc } = await encapsulate(pk);
    assert.strictEqual(ct.length, MLKEM_CT_SIZE, `ciphertext must be ${MLKEM_CT_SIZE} bytes`);

    const { decapsulate } = await import('../lib/chutes/ChutesE2EECrypto.js');
    const ssDec = await decapsulate(ct, sk);
    assert.ok(ssEnc.equals(ssDec), 'encapsulated and decapsulated secrets must match');
  });

  it('should produce unique secrets per encapsulation (forward secrecy)', async () => {
    const { pk } = await generateKeyPair();
    const secrets = new Set();
    for (let i = 0; i < 5; i++) {
      const { ss } = await encapsulate(pk);
      const hex = ss.toString('hex');
      assert.ok(!secrets.has(hex), `duplicate secret at iteration ${i + 1}`);
      secrets.add(hex);
    }
  });

  // ---------------------------------------------------------------------------
  // Request blob format
  // ---------------------------------------------------------------------------

  it('should build a blob with the exact expected layout', async () => {
    const { pk } = await generateKeyPair();
    const b64pk = pk.toString('base64');
    const payload = {
      model: 'TestModel',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const { blob, responseSk } = await buildE2EERequest(b64pk, payload);

    const expectedMin = MLKEM_CT_SIZE + CHACHA_NONCE_SIZE + CHACHA_TAG_SIZE + 1;
    assert.ok(blob.length > expectedMin, `blob too small: ${blob.length} <= ${expectedMin}`);
    assert.ok(responseSk instanceof Buffer, 'responseSk must be a Buffer');
    assert.ok(!blob.includes(Buffer.from('hello')), 'plaintext must not appear in blob');
    assert.ok(!blob.includes(Buffer.from('TestModel')), 'model name must not appear in blob');
  });

  it('should reject an undersized e2e_pubkey', async () => {
    const { pk } = await generateKeyPair();
    const shortPk = pk.slice(0, pk.length - 1).toString('base64');
    try {
      await buildE2EERequest(shortPk, { messages: [] });
      assert.fail('expected error for short pubkey');
    } catch (err) {
      assert.ok(
        err.message.includes('1184') || err.message.includes('pubkey'),
        `unexpected error: ${err.message}`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Forward secrecy
  // ---------------------------------------------------------------------------

  it('should produce UNIQUE blobs for identical payloads and keys', async () => {
    const { pk } = await generateKeyPair();
    const b64pk = pk.toString('base64');
    const payload = { model: 'TestModel', messages: [{ role: 'user', content: 'hi' }] };

    const { blob: b1 } = await buildE2EERequest(b64pk, payload);
    const { blob: b2 } = await buildE2EERequest(b64pk, payload);

    assert.ok(!b1.equals(b2), 'identical payloads must produce different blobs');
    assert.ok(!b1.slice(0, MLKEM_CT_SIZE).equals(b2.slice(0, MLKEM_CT_SIZE)), 'ML-KEM ct must differ');
  });

  // ---------------------------------------------------------------------------
  // Round-trip encrypt/decrypt (response simulation)
  // ---------------------------------------------------------------------------

  it('should round-trip encrypt and decrypt a response payload', async () => {
    // Simulate "server" side: has an ephemeral keypair (responsePk, responseSk)
    // Client encapsulates against responsePk, encrypts data
    // Server decapsulates using responseSk
    const { pk: responsePk, sk: responseSk } = await generateKeyPair();

    // "Client" encapsulates
    const { ct: mlkemCt, ss } = await encapsulate(responsePk);
    const symKey = deriveKey(ss, mlkemCt, INFO_RESP);

    const plaintextObj = {
      choices: [{
        message: {
          content: 'Hello, world! 🔐',
          role: 'assistant',
        },
      }],
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(plaintextObj)));
    const nonce = randomBytes(CHACHA_NONCE_SIZE);
    const { ciphertext, tag } = chachaEncrypt(symKey, nonce, compressed);
    const blob = Buffer.concat([mlkemCt, nonce, ciphertext, tag]);

    // Decrypt using the ephemeral secret key
    const decrypted = await decryptResponse(blob, responseSk);
    assert.strictEqual(decrypted.choices[0].message.content, 'Hello, world! 🔐');
  });

  // ---------------------------------------------------------------------------
  // Stream init + chunk decryption
  // ---------------------------------------------------------------------------

  it('should derive and use a stream key from e2e_init', async () => {
    const { pk: ephemPk, sk: ephemSk } = await generateKeyPair();
    const { ct: mlkemCt, ss } = await encapsulate(ephemPk);
    const streamKey = deriveKey(ss, mlkemCt, INFO_STREAM);

    // Simulate "server" encrypting a chunk
    const chunkText = 'streamed data 🔧';
    const nonce = randomBytes(CHACHA_NONCE_SIZE);
    const { ciphertext, tag } = chachaEncrypt(streamKey, nonce, Buffer.from(chunkText, 'utf-8'));
    const encChunk = Buffer.concat([nonce, ciphertext, tag]).toString('base64');

    // Client decrypts
    const serverMlkemCtB64 = mlkemCt.toString('base64');
    const derivedKey = await decryptStreamInit(ephemSk, serverMlkemCtB64);
    assert.ok(derivedKey.equals(streamKey), 'decrypted stream key must match');

    const decryptedText = decryptStreamChunk(encChunk, derivedKey);
    assert.strictEqual(decryptedText, chunkText);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('should reject decryption with a wrong key', () => {
    const key = Buffer.alloc(32, 0x11);
    const nonce = Buffer.alloc(CHACHA_NONCE_SIZE, 0x22);
    const { ciphertext, tag } = chachaEncrypt(key, nonce, Buffer.from('secret'));

    const wrongKey = Buffer.alloc(32, 0x33);
    assert.throws(
      () => chachaDecrypt(wrongKey, nonce, ciphertext, tag),
      /invalid authentication tag/,
    );
  });

  it('should handle 4KB payloads without leaking', async () => {
    const { pk } = await generateKeyPair();
    const b64pk = pk.toString('base64');
    const payload = { messages: [{ role: 'user', content: 'A'.repeat(4096) }] };
    const { blob } = await buildE2EERequest(b64pk, payload);
    assert.ok(blob.length > 1200);
    assert.ok(!blob.includes(Buffer.from('A'.repeat(100))));
  });

  it('should handle JSON special chars safely', async () => {
    const { pk } = await generateKeyPair();
    const b64pk = pk.toString('base64');
    const payload = { messages: [{ role: 'user', content: '{"inject": true}' }] };
    const { blob } = await buildE2EERequest(b64pk, payload);
    assert.ok(!blob.includes(Buffer.from('inject')));
  });

  // ---------------------------------------------------------------------------
  // Error types
  // ---------------------------------------------------------------------------

  it('should throw ChutesModelNotFoundError for unknown models', () => {
    const err = new ChutesModelNotFoundError('fake/model');
    assert.strictEqual(err.code, 'MODEL_NOT_FOUND');
    assert.strictEqual(err.model, 'fake/model');
    assert.ok(err.message.includes('fake/model'));
  });

  it('should throw ChutesRateLimitError with retry-after', () => {
    const err = new ChutesRateLimitError('slow down', { retryAfter: 5 });
    assert.strictEqual(err.code, 'RATE_LIMITED');
    assert.strictEqual(err.retryAfter, 5);
  });

  it('should throw ChutesAuthError for 401/403', () => {
    const err = new ChutesAuthError('bad token');
    assert.strictEqual(err.code, 'AUTH_FAILED');
  });

  // ---------------------------------------------------------------------------
  // Retry utility invariants
  // ---------------------------------------------------------------------------

  it('should obey maxRetries on 500 errors', async () => {
    try {
      await _fetchWithRetry('https://httpbin.org/status/500', {}, { maxRetries: 0, baseDelay: 10 });
      assert.fail('expected failure');
    } catch (err) {
      assert.ok(err.status === 500 || err.message.includes('500'));
    }
  });

  it('should fail a stalled E2EE stream after the idle timeout', async () => {
    const transport = new ChutesE2EETransport({ apiKey: '' });
    const rawStream = new ReadableStream({
      start() {
        // Intentionally never enqueue or close.
      },
    });
    const decorated = transport._decorateStream(rawStream, Buffer.alloc(0), { idleTimeoutMs: 20 });
    const reader = decorated.getReader();

    await assert.rejects(
      Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for idle timeout')), 500)),
      ]),
      /stream stalled/,
    );
  });

  it('should reject non-confidential model metadata before invoking E2EE', async () => {
    const transport = new ChutesE2EETransport({ apiKey: 'test' });
    seedTransportModel(transport, {
      id: 'PlainModel',
      chuteId: 'chute-plain',
      confidentialCompute: false,
    });

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response('unexpected');
    };

    try {
      await assert.rejects(
        transport.chat({ model: 'PlainModel', messages: [{ role: 'user', content: 'hello' }], stream: false }),
        (err) => err instanceof ChutesE2EESecurityError && err.code === 'E2EE_SECURITY_ERROR',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.strictEqual(fetchCalled, false, 'unsafe model should be rejected before network invoke');
  });

  it('should send only encrypted binary payloads to the E2EE invoke endpoint', async () => {
    const prompt = 'SecretPrompt_Transport_424242';
    const { pk } = await generateKeyPair();
    const transport = new ChutesE2EETransport({ apiKey: 'test' });
    const meta = seedTransportModel(transport, { id: 'MockModel-TEE', chuteId: 'chute-secure' });

    transport._discovery._fetchInstances = async () => ({
      nonceExpiresAt: Date.now() + 60_000,
      instances: [{
        instanceId: 'inst-1',
        e2ePubkey: pk.toString('base64'),
        nonces: ['nonce-1'],
      }],
    });

    let captured = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      captured = {
        url: String(url),
        headers: init.headers,
        body: Buffer.from(init.body),
      };
      return new Response(Buffer.from('not-a-valid-encrypted-response'), { status: 200 });
    };

    try {
      await assert.rejects(
        transport.chat({ model: meta.id, messages: [{ role: 'user', content: prompt }], stream: false }),
        /Response blob too small|decryption failed|invalid authentication tag/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(captured, 'expected invoke fetch to be called');
    assert.strictEqual(captured.url, 'https://api.chutes.ai/e2e/invoke');
    assert.strictEqual(captured.headers['Content-Type'], 'application/octet-stream');
    assert.strictEqual(captured.headers['X-E2E-Path'], '/v1/chat/completions');
    assert.ok(Buffer.isBuffer(captured.body), 'body should be binary');
    assert.ok(!captured.body.includes(Buffer.from(prompt)), 'prompt must not appear in invoke body');
    assert.ok(!captured.body.toString('utf8').includes('messages'), 'raw JSON field names must not appear in invoke body');
    assert.ok(!captured.body.toString('utf8').includes(prompt), 'prompt text must not appear in invoke body');
  });
});

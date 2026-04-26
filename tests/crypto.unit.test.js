/**
 * Unit tests for Chutes E2EE cryptographic primitives.
 *
 * NO API key required — pure crypto, no network calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  generateKeyPair,
  encapsulate,
  decapsulate,
  deriveKey,
  chachaEncrypt,
  chachaDecrypt,
  buildE2EERequest,
  decryptResponse,
  decryptStreamInit,
  decryptStreamChunk,
} from '../lib/chutes/ChutesE2EECrypto.js';

// ---------------------------------------------------------------------------
// ML-KEM key encapsulation
// ---------------------------------------------------------------------------

describe('ML-KEM-768 key encapsulation', () => {
  it('should generate a valid keypair', async () => {
    const { pk, sk } = await generateKeyPair();
    assert.strictEqual(pk.length, 1184, 'public key should be 1184 bytes');
    assert.strictEqual(sk.length, 2400, 'secret key should be 2400 bytes');
    assert.ok(pk instanceof Buffer, 'public key should be a Buffer');
    assert.ok(sk instanceof Buffer, 'secret key should be a Buffer');
    assert.ok(!pk.equals(Buffer.alloc(1184)), 'public key should not be all zeros');
  });

  it('should encapsulate and decapsulate a shared secret', async () => {
    const { pk, sk } = await generateKeyPair();
    const { ct, ss } = await encapsulate(pk);
    assert.strictEqual(ct.length, 1088, 'ciphertext should be 1088 bytes');
    assert.strictEqual(ss.length, 32, 'shared secret should be 32 bytes');
    assert.ok(!ss.equals(Buffer.alloc(32)), 'shared secret should not be all zeros');

    const ss2 = await decapsulate(ct, sk);
    assert.ok(ss.equals(ss2), 'decapsulated secret should match original');
  });

  it('should produce different secrets for different encapsulations', async () => {
    const { pk } = await generateKeyPair();
    const { ss: ss1 } = await encapsulate(pk);
    const { ss: ss2 } = await encapsulate(pk);
    assert.ok(!ss1.equals(ss2), 'two encapsulations should produce different secrets');
  });
});

// ---------------------------------------------------------------------------
// HKDF key derivation
// ---------------------------------------------------------------------------

describe('HKDF-SHA256 key derivation', () => {
  it('should derive a 32-byte key', () => {
    const ss = Buffer.alloc(32, 0xab);
    const ct = Buffer.alloc(1088, 0xcd);
    const info = Buffer.from('e2e-req-v1');
    const key = deriveKey(ss, ct, info);
    assert.strictEqual(key.length, 32, 'derived key should be 32 bytes');
    assert.ok(key instanceof Buffer, 'derived key should be a Buffer');
    assert.ok(!key.equals(ss), 'derived key should differ from input secret');
  });

  it('should produce different keys for different info strings', () => {
    const ss = Buffer.alloc(32, 0xab);
    const ct = Buffer.alloc(1088, 0xcd);
    const k1 = deriveKey(ss, ct, Buffer.from('e2e-req-v1'));
    const k2 = deriveKey(ss, ct, Buffer.from('e2e-resp-v1'));
    const k3 = deriveKey(ss, ct, Buffer.from('e2e-stream-v1'));
    assert.ok(!k1.equals(k2), 'req and resp keys should differ');
    assert.ok(!k2.equals(k3), 'resp and stream keys should differ');
    assert.ok(!k1.equals(k3), 'req and stream keys should differ');
  });

  it('should return Buffer (not ArrayBuffer)', () => {
    const key = deriveKey(Buffer.alloc(32), Buffer.alloc(1088), Buffer.from('e2e-req-v1'));
    assert.ok(key instanceof Buffer, 'hkdf return must be a Buffer for ChaCha20Poly1305');
    assert.ok(!(key instanceof ArrayBuffer), 'must not be raw ArrayBuffer');
  });
});

// ---------------------------------------------------------------------------
// ChaCha20-Poly1305 symmetric encryption
// ---------------------------------------------------------------------------

describe('ChaCha20-Poly1305 encryption', () => {
  it('should encrypt and decrypt round-trip', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const plaintext = Buffer.from('Hello, E2EE world! 🔐');

    const { ciphertext, tag } = chachaEncrypt(key, nonce, plaintext);
    assert.strictEqual(tag.length, 16, 'tag should be 16 bytes');
    assert.ok(ciphertext.length > 0, 'ciphertext should not be empty');

    const decrypted = chachaDecrypt(key, nonce, ciphertext, tag);
    assert.ok(decrypted instanceof Uint8Array, 'decrypted should be Uint8Array');
    assert.ok(Buffer.from(decrypted).equals(plaintext), 'round-trip should match');
  });

  it('should fail decryption with wrong key', () => {
    const key = Buffer.alloc(32, 0x11);
    const wrongKey = Buffer.alloc(32, 0x22);
    const nonce = Buffer.alloc(12, 0x33);
    const plaintext = Buffer.from('secret message');

    const { ciphertext, tag } = chachaEncrypt(key, nonce, plaintext);
    assert.throws(
      () => chachaDecrypt(wrongKey, nonce, ciphertext, tag),
      /invalid authentication tag/,
    );
  });

  it('should decrypt to string via Buffer.from()', () => {
    const key = Buffer.alloc(32, 0x11);
    const nonce = Buffer.alloc(12, 0x22);
    const plaintext = Buffer.from('The quick brown fox');

    const { ciphertext, tag } = chachaEncrypt(key, nonce, plaintext);
    const decrypted = chachaDecrypt(key, nonce, ciphertext, tag);
    const str = Buffer.from(decrypted).toString('utf-8');
    assert.strictEqual(str, 'The quick brown fox');
    // Critical: must NOT be comma-separated decimal string
    assert.ok(!str.startsWith('84,104,101'), 'decrypted string must NOT be comma-separated decimals');
  });
});

// ---------------------------------------------------------------------------
// High-level request encryption
// ---------------------------------------------------------------------------

describe('buildE2EERequest', () => {
  it('should produce a blob larger than ciphertext', async () => {
    const kp = await generateKeyPair();
    const e2ePubkeyB64 = kp.pk.toString('base64');
    const payload = {
      model: 'Qwen/Qwen3-32B-TEE',
      messages: [{ role: 'user', content: 'Hello world' }],
    };
    const { blob, responseSk } = await buildE2EERequest(e2ePubkeyB64, payload);
    assert.ok(blob.length > 1200, 'blob should be larger than ML-KEM ct + nonce');
    assert.strictEqual(responseSk.length, 2400, 'response secret key should be 2400 bytes');
  });

  it('should NOT leak plaintext in the blob', async () => {
    const { pk } = await generateKeyPair();
    const e2ePubkeyB64 = pk.toString('base64');
    const payload = {
      model: 'Qwen/Qwen3-32B-TEE',
      messages: [{ role: 'user', content: 'SecretPrompt_424242_xyz' }],
    };
    const { blob } = await buildE2EERequest(e2ePubkeyB64, payload);

    const asBinary = blob.toString('binary');
    assert.ok(!asBinary.includes('SecretPrompt'), 'prompt must not appear in plaintext blob');
    assert.ok(!blob.includes(Buffer.from('SecretPrompt')), 'prompt bytes must not appear in blob');
  });

  it('should include e2e_response_pk in the payload augmentation', async () => {
    const { pk } = await generateKeyPair();
    const e2ePubkeyB64 = pk.toString('base64');
    const payload = { model: 'test', messages: [] };
    const { responseSk } = await buildE2EERequest(e2ePubkeyB64, payload);
    assert.ok(responseSk.length > 0, 'response_sk should be present');
  });
});

// ---------------------------------------------------------------------------
// Decrypt response (mocked — no network)
// ---------------------------------------------------------------------------

describe('decryptResponse', () => {
  it('should round-trip encrypt then decrypt a response blob', async () => {
    // Generate ephemeral keypair
    const { pk: responsePk, sk: responseSk } = await generateKeyPair();

    // Simulate server: encapsulate against responsePk
    const { ct: mlkemCt, ss: sharedSecret } = await encapsulate(responsePk);
    const symKey = deriveKey(sharedSecret, mlkemCt, Buffer.from('e2e-resp-v1'));

    // Simulate server: encrypt response JSON
    const responseJson = {
      choices: [{ message: { content: 'Hello from TEE! 🛡️', role: 'assistant' } }],
      model: 'Qwen/Qwen3-32B-TEE',
    };
    const compressed = gzipSync(Buffer.from(JSON.stringify(responseJson)));
    const nonce = randomBytes(12);
    const { ciphertext, tag } = chachaEncrypt(symKey, nonce, compressed);
    const blob = Buffer.concat([mlkemCt, nonce, ciphertext, tag]);

    // Client decrypts
    const decrypted = await decryptResponse(blob, responseSk);
    assert.strictEqual(decrypted.choices[0].message.content, 'Hello from TEE! 🛡️');
    assert.strictEqual(decrypted.model, 'Qwen/Qwen3-32B-TEE');
  });
});

// ---------------------------------------------------------------------------
// Streaming decryption
// ---------------------------------------------------------------------------

describe('stream decryption', () => {
  it('should decrypt stream init and chunks', async () => {
    const { pk: responsePk, sk: responseSk } = await generateKeyPair();

    // Simulate server's e2e_init encapsulation
    const { ct: mlkemCt, ss: sharedSecret } = await encapsulate(responsePk);
    const streamKey = deriveKey(sharedSecret, mlkemCt, Buffer.from('e2e-stream-v1'));

    // Client receives e2e_init
    const initB64 = mlkemCt.toString('base64');
    const derivedStreamKey = await decryptStreamInit(responseSk, initB64);
    assert.ok(derivedStreamKey.equals(streamKey), 'derived stream key should match');

    // Server encrypts a chunk (plaintext — stream chunks are NOT gzipped)
    const chunk = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
    const nonce = randomBytes(12);
    const { ciphertext, tag } = chachaEncrypt(streamKey, nonce, Buffer.from(chunk));
    const encChunk = Buffer.concat([nonce, ciphertext, tag]).toString('base64');

    // Client decrypts chunk
    const decrypted = decryptStreamChunk(encChunk, derivedStreamKey);
    assert.ok(decrypted.includes('delta'), 'decrypted chunk should contain delta');
    assert.ok(decrypted.includes('hello'), 'decrypted chunk should contain chunk text');
  });
});

// ---------------------------------------------------------------------------
// Human-readable output verification
// ---------------------------------------------------------------------------

describe('human-readable output', () => {
  it('should produce human-readable text after decryption', async () => {
    const { pk: responsePk, sk: responseSk } = await generateKeyPair();
    const { ct: mlkemCt, ss: sharedSecret } = await encapsulate(responsePk);
    const symKey = deriveKey(sharedSecret, mlkemCt, Buffer.from('e2e-resp-v1'));

    const responseJson = { content: 'The quick brown fox jumps over the lazy dog.' };
    const compressed = gzipSync(Buffer.from(JSON.stringify(responseJson)));
    const nonce = randomBytes(12);
    const { ciphertext, tag } = chachaEncrypt(symKey, nonce, compressed);
    const blob = Buffer.concat([mlkemCt, nonce, ciphertext, tag]);

    const decrypted = await decryptResponse(blob, responseSk);
    const text = JSON.stringify(decrypted);

    // Must be human-readable English, not comma-separated ASCII codes
    assert.ok(text.includes('quick brown fox'), 'decrypted text must contain original English');
    assert.ok(!/^(\d{1,3},)+\d{1,3}$/.test(text), 'must NOT be comma-separated decimal ASCII codes');
    assert.ok(/[a-zA-Z\s]{10,}/.test(text), 'must contain continuous alphabetic text');
  });
});

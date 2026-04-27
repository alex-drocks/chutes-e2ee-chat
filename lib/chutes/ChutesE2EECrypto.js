/**
 * Chutes.ai E2EE cryptographic primitives.
 *
 * Implements ML-KEM-768 + HKDF-SHA256 + ChaCha20-Poly1305 in pure Node.js.
 *
 * All sizing constants are imported from constants.js so protocol and
 * crypto code stay in sync.
 */

import { hkdfSync, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { MlKem768 } from 'mlkem';
import { ChaCha20Poly1305 } from '@stablelib/chacha20poly1305';
import {
  MLKEM_CT_SIZE,
  MLKEM_PK_SIZE,
  CHACHA_NONCE_SIZE,
  CHACHA_TAG_SIZE,
  INFO_REQ,
  INFO_RESP,
  INFO_STREAM,
} from './constants.js';

/** Derive a 32-byte ChaCha20 key from ML-KEM shared secret. */
export function deriveKey(sharedSecret, mlkemCt, info) {
  // Salt is a public value — ML-KEM ciphertext prefix is used for domain
  // binding between the encapsulation and the HKDF derivation. HKDF security
  // does not require a secret salt; a fixed or context-bound salt is sufficient.
  const salt = mlkemCt.slice(0, 16);
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, info, 32));
}

/** Encrypt with ChaCha20-Poly1305. */
export function chachaEncrypt(key, nonce, plaintext) {
  const cipher = new ChaCha20Poly1305(key);
  const sealed = cipher.seal(nonce, plaintext, null);
  return {
    ciphertext: sealed.slice(0, -CHACHA_TAG_SIZE),
    tag: sealed.slice(-CHACHA_TAG_SIZE),
  };
}

/** Decrypt ChaCha20-Poly1305 ciphertext. */
export function chachaDecrypt(key, nonce, ciphertext, tag) {
  const cipher = new ChaCha20Poly1305(key);
  const plaintext = cipher.open(nonce, Buffer.concat([ciphertext, tag]), null);
  if (plaintext === null) {
    throw new Error('ChaCha20-Poly1305 decryption failed: invalid authentication tag');
  }
  return plaintext;
}

// Module-level KEM instance — node-seeded, CSPRNG-backed
const kem = new MlKem768();

/** Generate per-request ephemeral ML-KEM keypair. */
export async function generateKeyPair() {
  const [pk, sk] = await kem.generateKeyPair();
  return { pk: Buffer.from(pk), sk: Buffer.from(sk) };
}

/** Encapsulate shared secret against remote public key. */
export async function encapsulate(remotePk) {
  const [ct, ss] = await kem.encap(remotePk);
  return { ct: Buffer.from(ct), ss: Buffer.from(ss) };
}

/** Decapsulate shared secret using local secret key. */
export async function decapsulate(ct, sk) {
  const ss = await kem.decap(ct, sk);
  return Buffer.from(ss);
}

/** Build an encrypted E2EE request blob and return the response secret key. */
export async function buildE2EERequest(e2ePubkeyB64, payload) {
  const { pk: responsePk, sk: responseSk } = await generateKeyPair();

  const e2ePubkey = Buffer.from(e2ePubkeyB64, 'base64');
  if (e2ePubkey.length !== MLKEM_PK_SIZE) {
    throw new Error(`Expected e2e_pubkey ${MLKEM_PK_SIZE} bytes, got ${e2ePubkey.length}`);
  }

  const { ct: mlkemCt, ss: sharedSecret } = await encapsulate(e2ePubkey);
  const symKey = deriveKey(sharedSecret, mlkemCt, INFO_REQ);

  const payloadWithPk = {
    ...payload,
    e2e_response_pk: responsePk.toString('base64'),
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payloadWithPk)));

  const nonce = randomBytes(CHACHA_NONCE_SIZE);
  const { ciphertext, tag } = chachaEncrypt(symKey, nonce, compressed);

  // Blob layout: [ML-KEM ct][nonce][ciphertext][Poly1305 tag]
  const blob = Buffer.concat([mlkemCt, nonce, ciphertext, tag]);

  return { blob, responseSk };
}

/** Decrypt a non-streaming E2EE response blob. */
export async function decryptResponse(responseBlob, responseSk) {
  if (responseBlob.length < MLKEM_CT_SIZE + CHACHA_NONCE_SIZE + CHACHA_TAG_SIZE + 1) {
    throw new Error(`Response blob too small: ${responseBlob.length} bytes`);
  }

  const mlkemCt = responseBlob.slice(0, MLKEM_CT_SIZE);
  const nonce = responseBlob.slice(MLKEM_CT_SIZE, MLKEM_CT_SIZE + CHACHA_NONCE_SIZE);
  const ciphertext = responseBlob.slice(MLKEM_CT_SIZE + CHACHA_NONCE_SIZE, -CHACHA_TAG_SIZE);
  const tag = responseBlob.slice(-CHACHA_TAG_SIZE);

  const sharedSecret = await decapsulate(mlkemCt, responseSk);
  const symKey = deriveKey(sharedSecret, mlkemCt, INFO_RESP);
  const plaintext = chachaDecrypt(symKey, nonce, ciphertext, tag);
  const decompressed = gunzipSync(plaintext);
  return JSON.parse(decompressed.toString('utf-8'));
}

/** Decrypt the e2e_init SSE event to derive the stream key. */
export async function decryptStreamInit(responseSk, mlkemCtB64) {
  const mlkemCt = Buffer.from(mlkemCtB64, 'base64');
  const sharedSecret = await decapsulate(mlkemCt, responseSk);
  return deriveKey(sharedSecret, mlkemCt, INFO_STREAM);
}

/** Decrypt a single E2EE streaming chunk. */
export function decryptStreamChunk(encChunkB64, streamKey) {
  const raw = Buffer.from(encChunkB64, 'base64');
  if (raw.length < CHACHA_NONCE_SIZE + CHACHA_TAG_SIZE + 1) {
    throw new Error(`Stream chunk too small: ${raw.length} bytes`);
  }
  const nonce = raw.slice(0, CHACHA_NONCE_SIZE);
  const ciphertext = raw.slice(CHACHA_NONCE_SIZE, -CHACHA_TAG_SIZE);
  const tag = raw.slice(-CHACHA_TAG_SIZE);
  const plaintext = chachaDecrypt(streamKey, nonce, ciphertext, tag);
  return Buffer.from(plaintext).toString('utf-8');
}

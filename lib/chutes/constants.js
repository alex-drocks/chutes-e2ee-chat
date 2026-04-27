/**
 * Shared constants across the Chutes E2EE client.
 *
 * Centralising these prevents silent desyncs between crypto and protocol code.
 */

/** Chutes.ai production endpoints */
export const DEFAULT_API_BASE = 'https://api.chutes.ai';
export const DEFAULT_MODELS_BASE = 'https://llm.chutes.ai';

/** Cryptographic parameter sizes (bytes) */
export const MLKEM_CT_SIZE = 1088;    // ML-KEM-768 ciphertext
export const MLKEM_PK_SIZE = 1184;    // ML-KEM-768 public key
export const CHACHA_NONCE_SIZE = 12;   // ChaCha20 nonce
export const CHACHA_TAG_SIZE = 16;     // Poly1305 authentication tag
export const HKDF_KEY_SIZE = 32;       // ChaCha20 key size
export const MLKEM_SK_SIZE = 2400;     // ML-KEM-768 secret key

/** HKDF domain-separation info strings */
export const INFO_REQ = Buffer.from('e2e-req-v1');
export const INFO_RESP = Buffer.from('e2e-resp-v1');
export const INFO_STREAM = Buffer.from('e2e-stream-v1');

/** Cache and retry configuration */
export const MODEL_MAP_TTL_MS = 5 * 60 * 1000;   // 5 minutes
export const NONCE_TTL_S = 55;                    // Server default ~60s
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = { model: 15_000, instance: 30_000, invoke: 120_000 };

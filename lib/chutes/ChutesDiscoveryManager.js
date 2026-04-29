/**
 * Chutes.ai E2EE instance discovery, model resolution, and nonce cache.
 *
 * Model discovery uses retry for transient failures, but E2EE instance nonce
 * discovery does not retry automatically because nonce material is single-use
 * and model-level fallback is safer than hammering a failing chute.
 *
 * Nonce refresh is deduplicated per chuteId via `_nonceRefreshes` so
 * concurrent first-use callers can never independently consume the same
 * nonce — a protocol-level nonce-reuse risk for an encrypted transport.
 */

import { _fetchWithRetry } from './utils.js';
import { ChutesModelNotFoundError } from './errors.js';
import {
  DEFAULT_API_BASE,
  DEFAULT_MODELS_BASE,
  MODEL_MAP_TTL_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
} from './constants.js';

export class ChutesDiscoveryManager {
  constructor({ apiKey, apiBase = DEFAULT_API_BASE, modelsBase = DEFAULT_MODELS_BASE }) {
    this._apiBase = apiBase.replace(/\/$/, '');
    this._modelsBase = modelsBase.replace(/\/$/, '');
    this._authHeaders = { Authorization: `Bearer ${apiKey}` };

    // chute_id -> { instances[], expiresAt }
    this._nonceCache = new Map();

    // chute_id -> in-flight Promise<fresh> for the active refresh.
    // Ensures concurrent first-use callers share one fetch + one cache write,
    // preventing two callers from independently consuming the first nonce.
    this._nonceRefreshes = new Map();

    this._modelMap = new Map();
    this._modelMeta = new Map();
    this._modelMapLoadedAt = 0;
    this._modelMapRefreshing = null; // fetch-lock for concurrent refresh
  }

  getAuth() {
    return { ...this._authHeaders };
  }

  setAuth(apiKey) {
    this._authHeaders = { Authorization: `Bearer ${apiKey}` };
  }

  async resolveChuteId(model) {
    if (this._looksLikeUUID(model)) return model;
    await this._maybeRefreshModelMap();
    const chuteId = this._modelMap.get(model);
    if (chuteId) return chuteId;

    this._modelMapLoadedAt = 0;
    await this._maybeRefreshModelMap();
    const retry = this._modelMap.get(model);
    if (retry) return retry;

    throw new ChutesModelNotFoundError(model);
  }

  async _maybeRefreshModelMap() {
    const now = Date.now();
    if (now - this._modelMapLoadedAt < MODEL_MAP_TTL_MS) return;

    // Concurrent callers await a single in-flight refresh
    if (this._modelMapRefreshing) return this._modelMapRefreshing;

    this._modelMapRefreshing = _fetchWithRetry(`${this._modelsBase}/v1/models`, {
      headers: this._authHeaders,
      signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS.model),
    })
      .then(async (res) => {
        const data = await res.json();
        const newMap = new Map();
        const newMeta = new Map();
        for (const entry of data.data || []) {
          if (entry.id && entry.chute_id) {
            newMap.set(entry.id, entry.chute_id);
            newMeta.set(entry.id, {
              id: entry.id,
              chuteId: entry.chute_id,
              inputModalities: Array.isArray(entry.input_modalities) ? entry.input_modalities : ['text'],
              outputModalities: Array.isArray(entry.output_modalities) ? entry.output_modalities : ['text'],
              supportedFeatures: Array.isArray(entry.supported_features) ? entry.supported_features : [],
              contextLength: entry.context_length || entry.max_model_len || null,
              maxOutputLength: entry.max_output_length || null,
              confidentialCompute: Boolean(entry.confidential_compute),
            });
          }
        }
        this._modelMap = newMap;
        this._modelMeta = newMeta;
        this._modelMapLoadedAt = Date.now();
      })
      .finally(() => {
        this._modelMapRefreshing = null;
      });

    return this._modelMapRefreshing;
  }

  _looksLikeUUID(s) {
    const parts = s.split('-');
    if (parts.length !== 5) return false;
    const hex = s.replace(/-/g, '');
    return hex.length === 32 && /^[0-9a-f]+$/i.test(hex);
  }

  /**
   * Get an (instance, nonce) pair, fetching fresh ones if needed.
   *
   * Concurrent callers for the same chuteId share a single in-flight refresh
   * (see `_nonceRefreshes`) so they can never receive duplicate nonces from
   * independent fetches. If the shared fresh cache is drained by other
   * waiters, force one more refresh and retry — bounded to avoid runaway
   * recursion if the provider keeps returning empty nonce lists.
   *
   * @param {string} chuteId
   * @param {number} [_retries=0] — internal guard; do not pass externally
   * @returns {Promise<{ instanceId: string, e2ePubkey: string, nonce: string }>}
   */
  async getNonce(chuteId, _retries = 0) {
    const cached = this._nonceCache.get(chuteId);
    if (cached && Date.now() < cached.expiresAt) {
      const result = this._takeNonce(cached);
      if (result) return result;
    }

    // Evict expired or exhausted entries before fetching
    this._evictStaleNonceCache();

    let refresh = this._nonceRefreshes.get(chuteId);
    if (!refresh) {
      refresh = this._fetchInstances(chuteId)
        .then((discovery) => {
          const fresh = {
            instances: discovery.instances,
            expiresAt: discovery.nonceExpiresAt,
          };
          this._nonceCache.set(chuteId, fresh);
          return fresh;
        })
        .finally(() => {
          // Always clear the in-flight slot, success or failure, so a failed
          // refresh doesn't poison the map and block future retries.
          this._nonceRefreshes.delete(chuteId);
        });
      this._nonceRefreshes.set(chuteId, refresh);
    }

    const fresh = await refresh;
    const result = this._takeNonce(fresh);
    if (result) return result;

    // Other waiters drained the just-refreshed cache. Force one more refresh
    // and retry once — bounded so a misbehaving provider can't spin forever.
    if (_retries < 2) {
      this._nonceCache.delete(chuteId);
      return this.getNonce(chuteId, _retries + 1);
    }

    throw new Error(
      `No nonces available for chute ${chuteId}. ` +
        'The chute may have no active E2EE-capable instances.',
    );
  }

  /** Remove expired nonce cache entries to prevent unbounded growth. */
  _evictStaleNonceCache() {
    const now = Date.now();
    for (const [key, entry] of this._nonceCache) {
      if (now >= entry.expiresAt) {
        this._nonceCache.delete(key);
      }
    }
  }

  _takeNonce(cached) {
    for (const inst of cached.instances) {
      if (inst.nonces.length > 0) {
        return {
          instanceId: inst.instanceId,
          e2ePubkey: inst.e2ePubkey,
          nonce: inst.nonces.shift(),
        };
      }
    }
    return null;
  }

  async _fetchInstances(chuteId) {
    const res = await _fetchWithRetry(`${this._apiBase}/e2e/instances/${chuteId}`, {
      headers: this._authHeaders,
      signal: AbortSignal.timeout(30_000),
    }, { maxRetries: 0 });
    const data = await res.json();
    const instances = (data.instances || []).map((inst) => ({
      instanceId: inst.instance_id,
      e2ePubkey: inst.e2e_pubkey,
      nonces: [...(inst.nonces || [])],
    }));
    return {
      instances,
      nonceExpiresAt: Date.now() + (data.nonce_expires_in || 55) * 1000,
    };
  }

  clearNonceCache(chuteId) {
    if (chuteId) {
      this._nonceCache.delete(chuteId);
      this._nonceRefreshes.delete(chuteId);
    } else {
      this._nonceCache.clear();
      this._nonceRefreshes.clear();
    }
  }

  clearModelMap() {
    this._modelMap = new Map();
    this._modelMeta = new Map();
    this._modelMapLoadedAt = 0;
  }
}

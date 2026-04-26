/**
 * Chutes.ai E2EE instance discovery, model resolution, and nonce cache.
 */

const DEFAULT_API_BASE = 'https://api.chutes.ai';
const DEFAULT_MODELS_BASE = 'https://llm.chutes.ai';
const MODEL_MAP_TTL_MS = 5 * 60 * 1000;

export class ChutesDiscoveryManager {
  constructor({ apiKey, apiBase = DEFAULT_API_BASE, modelsBase = DEFAULT_MODELS_BASE }) {
    this._apiBase = apiBase.replace(/\/$/, '');
    this._modelsBase = modelsBase.replace(/\/$/, '');
    this._authHeaders = { Authorization: `Bearer ${apiKey}` };
    this._nonceCache = new Map();
    this._modelMap = new Map();
    this._modelMapLoadedAt = 0;
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

    throw new Error(
      `Could not resolve model '${model}' to a chute_id. Check the model name and availability at /v1/models.`,
    );
  }

  async _maybeRefreshModelMap() {
    const now = Date.now();
    if (now - this._modelMapLoadedAt < MODEL_MAP_TTL_MS) return;

    const url = `${this._modelsBase}/v1/models`;
    const res = await fetch(url, {
      headers: this._authHeaders,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch model map: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    const newMap = new Map();
    for (const entry of data.data || []) {
      if (entry.id && entry.chute_id) {
        newMap.set(entry.id, entry.chute_id);
      }
    }
    this._modelMap = newMap;
    this._modelMapLoadedAt = Date.now();
  }

  _looksLikeUUID(s) {
    const parts = s.split('-');
    if (parts.length !== 5) return false;
    const hex = s.replace(/-/g, '');
    return hex.length === 32 && /^[0-9a-f]+$/i.test(hex);
  }

  async getNonce(chuteId) {
    const cached = this._nonceCache.get(chuteId);
    if (cached && Date.now() < cached.expiresAt) {
      const result = this._takeNonce(cached);
      if (result) return result;
    }

    const discovery = await this._fetchInstances(chuteId);
    const fresh = {
      instances: discovery.instances,
      expiresAt: discovery.nonceExpiresAt,
    };
    this._nonceCache.set(chuteId, fresh);

    const result = this._takeNonce(fresh);
    if (result) return result;

    throw new Error(`No nonces available for chute ${chuteId}.`);
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
    const url = `${this._apiBase}/e2e/instances/${chuteId}`;
    const res = await fetch(url, {
      headers: this._authHeaders,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch instances: ${res.status} ${res.statusText}`);
    }
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
    if (chuteId) this._nonceCache.delete(chuteId);
    else this._nonceCache.clear();
  }

  clearModelMap() {
    this._modelMap = new Map();
    this._modelMapLoadedAt = 0;
  }
}

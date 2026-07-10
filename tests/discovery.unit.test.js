/**
 * ChutesDiscoveryManager unit tests — offline, no API key needed.
 *
 * Covers the upstream hardening patterns:
 *  1. In-flight nonce refresh deduplication (PRD-045 §5.1)
 *  2. Drained-shared-cache bounded retry
 *  3. Failed-refresh recovery (slot clearing)
 *  4. Parallel chute isolation
 *
 * NOTE: Uses top-level test() (describe() avoided because Bun's node:test
 * polyfill is fragile when any prior test errored — issue #5090).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChutesDiscoveryManager } from '../lib/chutes/ChutesDiscoveryManager.js';

test('getNonce: concurrent callers for same chute share one fetch and get distinct nonces', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'test' });

  let fetchCount = 0;
  manager._fetchInstances = async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      nonceExpiresAt: Date.now() + 60_000,
      instances: [
        {
          instanceId: 'inst-1',
          e2ePubkey: 'pubkey',
          nonces: ['nonce-a', 'nonce-b', 'nonce-c'],
        },
      ],
    };
  };

  const results = await Promise.all([
    manager.getNonce('chute-1'),
    manager.getNonce('chute-1'),
    manager.getNonce('chute-1'),
  ]);

  assert.strictEqual(fetchCount, 1, 'expected only one in-flight refresh');
  const nonces = results.map((r) => r.nonce);
  assert.strictEqual(new Set(nonces).size, 3, 'expected three distinct nonces');
});

test('getNonce: parallel chuteIds refresh independently — no global serialization', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'test' });

  const seen = [];
  manager._fetchInstances = async (chuteId) => {
    seen.push(chuteId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      nonceExpiresAt: Date.now() + 60_000,
      instances: [
        {
          instanceId: `inst-${chuteId}`,
          e2ePubkey: 'pubkey',
          nonces: [`nonce-${chuteId}`],
        },
      ],
    };
  };

  const [a, b] = await Promise.all([
    manager.getNonce('chute-A'),
    manager.getNonce('chute-B'),
  ]);

  assert.strictEqual(a.nonce, 'nonce-chute-A');
  assert.strictEqual(b.nonce, 'nonce-chute-B');
  assert.deepStrictEqual([...seen].sort(), ['chute-A', 'chute-B']);
});

test('getNonce: drained shared cache forces bounded retry, never loops forever', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'test' });

  let fetchCount = 0;
  manager._fetchInstances = async () => {
    fetchCount += 1;
    return {
      nonceExpiresAt: Date.now() + 60_000,
      instances: [
        {
          instanceId: 'inst-1',
          e2ePubkey: 'pubkey',
          nonces: [`nonce-${fetchCount}`],
        },
      ],
    };
  };

  const settled = await Promise.allSettled(
    Array.from({ length: 5 }, () => manager.getNonce('chute-1')),
  );

  const fulfilled = settled.filter((s) => s.status === 'fulfilled');
  const rejected = settled.filter((s) => s.status === 'rejected');

  assert.ok(fulfilled.length >= 1, 'expected at least one caller to succeed');
  const successNonces = fulfilled.map((s) => s.value.nonce);
  assert.strictEqual(
    new Set(successNonces).size,
    successNonces.length,
    'no two callers should ever receive the same nonce',
  );

  for (const r of rejected) {
    assert.match(r.reason.message, /No nonces available/);
  }
});

test('getNonce: failed refresh clears in-flight slot so retries can proceed', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'test' });

  let attempt = 0;
  manager._fetchInstances = async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error('simulated network blip');
    }
    return {
      nonceExpiresAt: Date.now() + 60_000,
      instances: [
        {
          instanceId: 'inst-1',
          e2ePubkey: 'pubkey',
          nonces: ['nonce-recovered'],
        },
      ],
    };
  };

  await assert.rejects(manager.getNonce('chute-1'), /simulated network blip/);
  assert.strictEqual(manager._nonceRefreshes.has('chute-1'), false, 'in-flight slot must be cleared after failure');

  const ok = await manager.getNonce('chute-1');
  assert.strictEqual(ok.nonce, 'nonce-recovered');
  assert.strictEqual(attempt, 2);
});

test('clearNonceCache also wipes in-flight refresh state', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'test' });

  const neverResolves = new Promise(() => {});
  manager._nonceRefreshes.set('chute-X', neverResolves);

  manager.clearNonceCache('chute-X');
  assert.strictEqual(manager._nonceRefreshes.has('chute-X'), false);

  manager._nonceRefreshes.set('chute-Y', neverResolves);
  manager.clearNonceCache(); // clear all
  assert.strictEqual(manager._nonceRefreshes.has('chute-Y'), false);
});

test('_maybeRefreshModelMap: concurrent callers share one refresh without duplicate fetches', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'test' });

  let fetchCount = 0;
  manager._modelMapRefreshing = new Promise((resolve) => {
    setTimeout(() => {
      fetchCount += 1;
      manager._modelMap.set('model-a', 'chute-1');
      manager._modelMapLoadedAt = Date.now();
      manager._modelMapRefreshing = null;
      resolve();
    }, 15);
  });

  await Promise.all([
    manager._maybeRefreshModelMap(),
    manager._maybeRefreshModelMap(),
  ]);

  assert.strictEqual(fetchCount, 1, 'expected only one model map refresh');
  assert.strictEqual(manager._modelMap.get('model-a'), 'chute-1');
  assert.strictEqual(manager._modelMapRefreshing, null, '_modelMapRefreshing must be cleared');
});

test('clearNonceCache: an older refresh cannot delete or overwrite its replacement', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'test' });
  const refreshes = [];
  let fetchCount = 0;

  manager._fetchInstances = async () => {
    fetchCount += 1;
    return new Promise((resolve) => refreshes.push(resolve));
  };

  const firstRequest = manager.getNonce('chute-1');
  manager.clearNonceCache('chute-1');
  const secondRequest = manager.getNonce('chute-1');

  assert.strictEqual(fetchCount, 2, 'cache invalidation should start a replacement refresh');

  refreshes[0]({
    nonceExpiresAt: Date.now() + 60_000,
    instances: [{ instanceId: 'old-inst', e2ePubkey: 'old-key', nonces: ['old-nonce'] }],
  });
  const first = await firstRequest;
  assert.strictEqual(first.nonce, 'old-nonce');
  assert.strictEqual(
    manager._nonceRefreshes.has('chute-1'),
    true,
    'the older refresh must not remove the replacement in-flight slot',
  );

  refreshes[1]({
    nonceExpiresAt: Date.now() + 60_000,
    instances: [{ instanceId: 'new-inst', e2ePubkey: 'new-key', nonces: ['new-a', 'new-b'] }],
  });
  const second = await secondRequest;
  const cached = await manager.getNonce('chute-1');

  assert.strictEqual(second.nonce, 'new-a');
  assert.strictEqual(cached.nonce, 'new-b', 'the replacement response should own the cache');
  assert.strictEqual(fetchCount, 2, 'the remaining replacement nonce should be served from cache');
});

test('setAuth: invalidates credential-scoped caches and ignores an older model response', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'old-key' });
  const originalFetch = globalThis.fetch;
  let resolveOldFetch;
  const seenAuth = [];
  let fetchCount = 0;

  globalThis.fetch = async (_url, init) => {
    fetchCount += 1;
    seenAuth.push(init.headers.Authorization);
    if (fetchCount === 1) {
      return new Promise((resolve) => {
        resolveOldFetch = resolve;
      });
    }

    return new Response(JSON.stringify({
      data: [{ id: 'new-model', chute_id: 'new-chute', confidential_compute: true }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    manager._nonceCache.set('old-chute', { instances: [], expiresAt: Date.now() + 60_000 });
    const oldRefresh = manager._maybeRefreshModelMap();

    manager.setAuth('new-key');
    assert.strictEqual(manager._nonceCache.size, 0, 'nonce cache should be cleared on credential rotation');

    const newRefresh = manager._maybeRefreshModelMap();
    resolveOldFetch(new Response(JSON.stringify({
      data: [{ id: 'old-model', chute_id: 'old-chute', confidential_compute: true }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await Promise.all([oldRefresh, newRefresh]);

    assert.deepStrictEqual(seenAuth, ['Bearer old-key', 'Bearer new-key']);
    assert.strictEqual(manager._modelMap.has('old-model'), false);
    assert.strictEqual(manager._modelMap.get('new-model'), 'new-chute');
    assert.deepStrictEqual(manager.getAuth(), { Authorization: 'Bearer new-key' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model discovery: does not coerce a string confidential flag to true', async () => {
  const manager = new ChutesDiscoveryManager({ apiKey: 'test' });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{
      id: 'not-actually-confidential',
      chute_id: 'chute-1',
      confidential_compute: 'false',
      input_modalities: ['text'],
      output_modalities: ['text'],
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    await assert.rejects(
      manager.resolveE2EEChuteId('not-actually-confidential'),
      /not advertised as a confidential-compute text model/,
    );
    assert.strictEqual(
      manager._modelMeta.get('not-actually-confidential').confidentialCompute,
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

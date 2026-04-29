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

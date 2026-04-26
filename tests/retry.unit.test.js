/**
 * Test retry/backoff behavior for rate limiting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _fetchWithRetry } from '../lib/chutes/ChutesDiscoveryManager.js';

describe('_fetchWithRetry', () => {
  it('should return successful response immediately', async () => {
    // Use a URL that always works
    const t0 = Date.now();
    const res = await _fetchWithRetry('https://httpbin.org/get', {}, { maxRetries: 2, baseDelay: 50 });
    assert.ok(res.ok);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 500, 'should not have retried for success');
  });

  it('should fail after max retries on bad URL', async () => {
    try {
      await _fetchWithRetry('https://httpbin.org/status/500', {}, { maxRetries: 2, baseDelay: 50 });
      assert.fail('expected failure');
    } catch (err) {
      assert.ok(err.message.includes('500') || err.message.includes('Max retries'));
    }
  });
});

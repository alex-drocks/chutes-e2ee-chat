/**
 * Test retry/backoff behavior for rate limiting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _fetchWithRetry } from '../lib/chutes/utils.js';

import { ChutesError } from '../lib/chutes/errors.js';

describe('_fetchWithRetry', () => {
  it('should return successful response immediately', async () => {
    const t0 = Date.now();
    const res = await _fetchWithRetry('https://httpbin.org/get', {}, { maxRetries: 2, baseDelay: 50 });
    assert.ok(res.ok);
    assert.ok(Date.now() - t0 < 500, 'should not have retried for success');
  });

  it('should fail fast on non-retriable 4xx (except 429)', async () => {
    try {
      await _fetchWithRetry('https://httpbin.org/status/400', {}, { maxRetries: 2, baseDelay: 10 });
      assert.fail('expected failure');
    } catch (err) {
      assert.ok(err instanceof ChutesError, `expected ChutesError, got ${err.constructor.name}`);
      assert.strictEqual(err.status, 400);
    }
  });

  it('should fail after max retries on 500 error', async () => {
    const t0 = Date.now();
    try {
      await _fetchWithRetry('https://httpbin.org/status/500', {}, { maxRetries: 2, baseDelay: 50 });
      assert.fail('expected failure');
    } catch (err) {
      assert.ok(err instanceof ChutesError);
      assert.ok(err.message.includes('500'));
      assert.ok(Date.now() - t0 >= 50, 'should have retried at least once');
    }
  });
});

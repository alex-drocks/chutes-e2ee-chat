/**
 * Test retry/backoff behavior for rate limiting.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _fetchWithRetry } from '../lib/chutes/utils.js';

import { ChutesError } from '../lib/chutes/errors.js';

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

describe('_fetchWithRetry', () => {
  it('should return successful response immediately', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('ok', { status: 200 });
    };

    const res = await _fetchWithRetry('https://example.test/get', {}, { maxRetries: 2, baseDelay: 50 });

    assert.ok(res.ok);
    assert.strictEqual(calls, 1);
  });

  it('should fail fast on non-retriable 4xx (except 429)', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('bad request', { status: 400, statusText: 'Bad Request' });
    };

    try {
      await _fetchWithRetry('https://example.test/status/400', {}, { maxRetries: 2, baseDelay: 10 });
      assert.fail('expected failure');
    } catch (err) {
      assert.ok(err instanceof ChutesError, `expected ChutesError, got ${err.constructor.name}`);
      assert.strictEqual(err.status, 400);
      assert.strictEqual(calls, 1);
    }
  });

  it('should fail after max retries on 500 error', async () => {
    let calls = 0;
    Math.random = () => 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('server error', { status: 500, statusText: 'Internal Server Error' });
    };

    try {
      await _fetchWithRetry('https://example.test/status/500', {}, { maxRetries: 2, baseDelay: 1 });
      assert.fail('expected failure');
    } catch (err) {
      assert.ok(err instanceof ChutesError);
      assert.ok(err.message.includes('500'));
      assert.strictEqual(calls, 3);
    }
  });
});

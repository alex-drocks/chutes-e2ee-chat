/**
 * Low-level HTTP utilities for Chutes E2EE transport.
 */

import { ChutesError, ChutesRateLimitError, ChutesAuthError, ChutesNetworkError } from './errors.js';
import { DEFAULT_MAX_RETRIES, DEFAULT_BASE_DELAY_MS } from './constants.js';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getErrorName(err) {
  return err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err || 'Unknown error');
}

/**
 * Fetch with automatic retry for transient failures.
 *
 * Distinguishes HTTP errors (status codes) from network errors (DNS, TCP, etc.)
 * and throws typed ChutesError subclasses so callers can decide what to do.
 */
export async function _fetchWithRetry(
  url,
  init,
  { maxRetries = DEFAULT_MAX_RETRIES, baseDelay = DEFAULT_BASE_DELAY_MS } = {},
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // User/timeout abort — never retry
      if (getErrorName(err) === 'AbortError') {
        throw new ChutesNetworkError(`Request aborted: ${url}`, { cause: err });
      }
      const message = getErrorMessage(err);
      // Network error (DNS, TCP, timeout, etc.)
      if (attempt >= maxRetries) {
        throw new ChutesNetworkError(`Network error fetching ${url}: ${message}`, { cause: err });
      }
      const delay = baseDelay * 2 ** attempt + Math.random() * 1000;
      console.warn(`  [retry] ${url} → network error (${message}), retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
      continue;
    }

    if (res.ok) return res;

    // Distinguish retriable vs fatal HTTP errors
    const isRetriable = res.status === 429 || res.status >= 500;
    const delay = baseDelay * 2 ** attempt + Math.random() * 1000;

    if (isRetriable && attempt < maxRetries) {
      console.warn(`  [retry] ${url} → ${res.status}, retrying in ${Math.round(delay)}ms...`);
      await sleep(delay);
      continue;
    }

    // Fatal HTTP error — throw typed error
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10) || undefined;
      throw new ChutesRateLimitError(`Rate limited: ${url} → ${res.status}`, {
        status: res.status,
        retryAfter,
      });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ChutesAuthError(`Authentication failed: ${url} → ${res.status}`, { status: res.status });
    }
    throw new ChutesError(`HTTP ${res.status} ${res.statusText}`, { status: res.status });
  }

  throw new ChutesError(`Max retries reached for ${url}`);
}

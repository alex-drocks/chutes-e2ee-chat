/**
 * Typed error hierarchy for Chutes E2EE.
 *
 * Allows callers to distinguish between rate-limiting, auth failures,
 * model-not-found, and transient network errors without regex-parsing
 * error messages.
 */

export class ChutesError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, { cause });
    this.name = 'ChutesError';
    this.code = code;
    this.status = status;
  }
}

/** Rate limited — caller should back off and retry */
export class ChutesRateLimitError extends ChutesError {
  constructor(message, { retryAfter, ...opts } = {}) {
    super(message, { code: 'RATE_LIMITED', ...opts });
    this.name = 'ChutesRateLimitError';
    this.retryAfter = retryAfter;
  }
}

/** API key rejected or missing */
export class ChutesAuthError extends ChutesError {
  constructor(message, opts = {}) {
    super(message, { code: 'AUTH_FAILED', ...opts });
    this.name = 'ChutesAuthError';
  }
}

/** Model name could not be resolved to a chute_id */
export class ChutesModelNotFoundError extends ChutesError {
  constructor(model, opts = {}) {
    super(`Model '${model}' not found. Check /v1/models for available chutes.`, {
      code: 'MODEL_NOT_FOUND',
      ...opts,
    });
    this.name = 'ChutesModelNotFoundError';
    this.model = model;
  }
}

/** E2EE safety invariant failed before sending a request */
export class ChutesE2EESecurityError extends ChutesError {
  constructor(message, opts = {}) {
    super(message, { code: 'E2EE_SECURITY_ERROR', ...opts });
    this.name = 'ChutesE2EESecurityError';
  }
}

/** Network-level failure (DNS, TCP, TLS, timeout) - safe to retry */
export class ChutesNetworkError extends ChutesError {
  constructor(message, { cause, ...opts } = {}) {
    super(message, { code: 'NETWORK_ERROR', cause, ...opts });
    this.name = 'ChutesNetworkError';
  }
}

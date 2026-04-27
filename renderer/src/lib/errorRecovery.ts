import type { ClassifiedError, ErrorReason, RecoveryStrategy } from './types';

export function classifyError(error: string): ClassifiedError {
  const msg = (error || '').toLowerCase();

  // Rate limit
  if (msg.includes('429') || msg.includes('rate') || msg.includes('throttled') || msg.includes('too many')) {
    return {
      reason: 'rate_limit',
      message: 'Rate limited — retrying after cooldown',
      retryable: true,
      shouldRetryWithDelay: true,
      shouldTruncateContext: false,
      shouldFallback: true,
      delayMs: 4000,
    };
  }

  // Auth
  if (msg.includes('401') || msg.includes('403') || msg.includes('auth') || msg.includes('unauthorized') || msg.includes('forbidden')) {
    return {
      reason: 'auth',
      message: 'Authentication failed — check your API key',
      retryable: false,
      shouldRetryWithDelay: false,
      shouldTruncateContext: false,
      shouldFallback: false,
      delayMs: 0,
    };
  }

  // Context overflow
  if (msg.includes('context') || msg.includes('too long') || msg.includes('token limit') || msg.includes('413') || msg.includes('max length')) {
    return {
      reason: 'context_overflow',
      message: 'Context too large — trimming history and retrying',
      retryable: true,
      shouldRetryWithDelay: false,
      shouldTruncateContext: true,
      shouldFallback: true,
      delayMs: 500,
    };
  }

  // Timeout / transport
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econn') || msg.includes('enotfound')) {
    return {
      reason: 'timeout',
      message: 'Connection timed out — reconnecting',
      retryable: true,
      shouldRetryWithDelay: true,
      shouldTruncateContext: false,
      shouldFallback: true,
      delayMs: 2500,
    };
  }

  // Network
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('abort') || msg.includes('failed to fetch')) {
    return {
      reason: 'network',
      message: 'Network hiccup — retrying',
      retryable: true,
      shouldRetryWithDelay: true,
      shouldTruncateContext: false,
      shouldFallback: true,
      delayMs: 2000,
    };
  }

  // Server errors
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('server error')) {
    return {
      reason: 'server_error',
      message: 'Server error — retrying',
      retryable: true,
      shouldRetryWithDelay: true,
      shouldTruncateContext: false,
      shouldFallback: true,
      delayMs: 2000,
    };
  }

  // Overloaded
  if (msg.includes('overloaded') || msg.includes('capacity') || msg.includes('529') || msg.includes('busy')) {
    return {
      reason: 'overloaded',
      message: 'Model overloaded — switching to fallback',
      retryable: true,
      shouldRetryWithDelay: true,
      shouldTruncateContext: false,
      shouldFallback: true,
      delayMs: 2000,
    };
  }

  return {
    reason: 'unknown',
    message: 'Unexpected issue — retrying',
    retryable: true,
    shouldRetryWithDelay: true,
    shouldTruncateContext: false,
    shouldFallback: false,
    delayMs: 1500,
  };
}

export function buildRecoveryStrategies(
  classified: ClassifiedError,
  fallbackModels: string[],
  currentModel: string,
): RecoveryStrategy[] {
  const strategies: RecoveryStrategy[] = [];

  // Strategy 1: Wait and retry same model
  if (classified.shouldRetryWithDelay) {
    strategies.push({
      strategy: 'wait_retry',
      model: currentModel,
      delayMs: classified.delayMs,
      truncateContext: false,
    });
  }

  // Strategy 2: Truncate context and retry same model
  if (classified.shouldTruncateContext) {
    strategies.push({
      strategy: 'truncate_retry',
      model: currentModel,
      delayMs: 500,
      truncateContext: true,
    });
  }

  // Strategy 3: Switch to fallback models (skip current)
  if (classified.shouldFallback) {
    for (const fallback of fallbackModels.filter((m) => m !== currentModel)) {
      strategies.push({
        strategy: 'fallback_model',
        model: fallback,
        delayMs: 500,
        truncateContext: false,
      });
    }
  }

  return strategies;
}

export function friendlyErrorMessage(classified: ClassifiedError, raw?: string): string {
  if (classified.reason === 'auth') {
    return 'Authentication failed.\n\nYour API key may be invalid or expired. Check Settings to update it.';
  }
  if (classified.reason === 'rate_limit') {
    return 'Hit rate limit.\n\nThe service is busy. Please wait a moment and try again.';
  }
  if (classified.reason === 'context_overflow') {
    return 'Conversation too long.\n\nThe model ran out of context. Try starting a new chat.';
  }
  if (classified.reason === 'network' || classified.reason === 'timeout') {
    return 'Connection issue.\n\nCould not reach Chutes TEE. Please check your connection and try again.';
  }
  if (classified.reason === 'overloaded') {
    return 'Model overloaded.\n\nAll endpoints are busy. Please try again in a moment.';
  }
  if (raw && raw.length < 200) return raw;
  return 'Something went wrong.\n\nPlease try again.';
}

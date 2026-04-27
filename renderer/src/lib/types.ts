export interface MessageStatus {
  done: boolean;
  action: string;
  description: string;
  timestamp: number;
  level?: 'info' | 'warning' | 'error' | 'success';
}

export interface MessageMemory {
  source: 'recalled' | 'saved';
  label: string;
  content: string;
  id: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  isStreaming?: boolean;
  isError?: boolean;
  isEmpty?: boolean;
  done?: boolean;
  statusHistory?: MessageStatus[];
  memoryContext?: MessageMemory[];
  recoveredFromError?: boolean;
  modelUsed?: string;
}

export type ErrorReason =
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'timeout'
  | 'server_error'
  | 'overloaded'
  | 'network'
  | 'unknown';

export interface ClassifiedError {
  reason: ErrorReason;
  message: string;
  retryable: boolean;
  shouldRetryWithDelay: boolean;
  shouldTruncateContext: boolean;
  shouldFallback: boolean;
  delayMs: number;
}

export interface RecoveryStrategy {
  strategy: 'wait_retry' | 'truncate_retry' | 'fallback_model';
  model: string;
  delayMs: number;
  truncateContext: boolean;
}

declare global {
  interface Window {
    chutes: {
      chat: (requestId: string, params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
        max_tokens?: number;
      }) => Promise<{ ok: boolean; stream?: boolean; body?: any; error?: string }>;
      abort: (requestId: string) => void;
      models: () => Promise<{ ok: boolean; models?: string[]; error?: string }>;
      modelStats: () => Promise<{ ok: boolean; stats?: Record<string, ChutesModelStats>; error?: string }>;
      onStreamChunk: (callback: (payload: { requestId: string; data?: string; done?: boolean }) => void) => () => void;
      onStreamError: (callback: (payload: { requestId: string; error: string }) => void) => () => void;
      saveApiKey: (provider: string, apiKey: string) => Promise<ApiKeyStatusResponse>;
      getApiKeyStatus: (provider: string) => Promise<ApiKeyStatusResponse>;
      deleteApiKey: (provider: string) => Promise<ApiKeyStatusResponse>;
    };
  }

  type ApiKeyStatusResponse = {
    ok: boolean;
    hasApiKey?: boolean;
    hasStoredKey?: boolean;
    source?: 'stored' | 'none';
    canPersist?: boolean;
    storageMode?: 'safeStorage' | 'localFileKey';
    storageBackend?: string;
    isOsBackedStorage?: boolean;
    error?: string;
  };

  type ChutesModelStats = {
    chuteId: string;
    name: string;
    date: string;
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    averageTps: number;
    averageTtft: number;
    timestamp?: string;
    activeInstanceCount?: number;
    totalInstanceCount?: number;
    utilizationCurrent?: number;
    utilization5m?: number;
    utilization15m?: number;
    utilization1h?: number;
    rateLimitRatio5m?: number;
    rateLimitRatio15m?: number;
    rateLimitRatio1h?: number;
    scalable?: boolean;
    scaleAllowance?: number;
  };
}

export {};

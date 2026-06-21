declare global {
  interface Window {
    chutes: {
      chat: (requestId: string, params: {
        model: string;
        messages: Array<{
          role: string;
          content?: string | ChutesMessageContentPart[] | null;
          tool_calls?: ChutesToolCall[];
          tool_call_id?: string;
          name?: string;
        }>;
        stream?: boolean;
        max_tokens?: number;
        tools?: ChutesToolDefinition[];
        tool_choice?: 'auto' | 'none' | string | Record<string, unknown>;
      }) => Promise<{ ok: boolean; stream?: boolean; body?: unknown; modelUsed?: string; error?: string }>;
      abort: (requestId: string) => Promise<{ ok: boolean; error?: string }>;
      models: () => Promise<{ ok: boolean; models?: string[]; metadata?: ChutesModelMetadata[]; error?: string }>;
      modelStats: () => Promise<{ ok: boolean; stats?: Record<string, ChutesModelStats>; error?: string }>;
      webSearch: (query: string, deepSearch?: boolean) => Promise<ChutesWebSearchResponse>;
      clipboardImage: () => Promise<{ ok: boolean; hasImage?: boolean; dataUrl?: string; mimeType?: string; size?: number; source?: string; error?: string }>;
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

  type ChutesModelMetadata = {
    id: string;
    chuteId: string;
    inputModalities: string[];
    outputModalities: string[];
    supportedFeatures: string[];
    contextLength?: number | null;
    maxOutputLength?: number | null;
    confidentialCompute: boolean;
  };

  type ChutesWebSearchResult = {
    title: string;
    url: string;
    snippet: string;
    article?: string;
    articleSource?: 'jina_reader' | 'direct_fetch';
  };

  type ChutesWebSearchResponse = {
    ok: boolean;
    results?: ChutesWebSearchResult[];
    fetchedAt?: string;
    provider?: string;
    deepSearch?: boolean;
    extractedCount?: number;
    extractionAttemptedCount?: number;
    totalResults?: number;
    errors?: number;
    error?: string;
  };

  type ChutesMessageContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

  type ChutesToolCall = {
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  };

  type ChutesToolDefinition = {
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  };
}

export {};

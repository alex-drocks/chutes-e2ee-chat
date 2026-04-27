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
}

export {};

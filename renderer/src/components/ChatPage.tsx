'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithToolCalls, type FileUIPart } from 'ai';
import {
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Fingerprint,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Lock,
  Newspaper,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Shield,
  Sparkles,
  Square,
  Trash2,
  User,
  WifiOff,
  X,
  Zap,
} from 'lucide-react';

import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message as AIMessage,
  MessageAvatar,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/components/ai-elements/prompt-input';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import { Sources, type SourceItem } from '@/components/ai-elements/sources';
import { Tool, ToolContent, ToolHeader } from '@/components/ai-elements/tool';
import { MemoryRecallFencing } from '@/components/MemoryRecallFencing';
import { LiveStatusCard, StatusTimeline } from '@/components/StatusTimeline';
import { MemoryStore } from '@/lib/memoryStore';
import {
  ChutesChatTransport,
  type ChutesChatConfig,
  type ChutesMessageMetadata,
  type ChutesUIMessage,
} from '@/lib/ai/chutesTransport';
import { cn } from '@/lib/utils';
import type {
  MessageAttachment,
  MessageMemory,
  MessageStatus,
} from '@/lib/types';
const MODEL_STORAGE_KEY = 'chutes-e2ee-chat.lastModel';

const DEEP_SEARCH_STORAGE_KEY = 'chutes-e2ee-chat.deepSearch';
const MAX_RETRIES = 2;

type StreamStage = 'idle' | 'encrypting' | 'connecting' | 'thinking' | 'streaming';

type ApiKeyStatus = {
  hasApiKey: boolean;
  hasStoredKey: boolean;
  source: 'stored' | 'none';
  canPersist: boolean;
  storageMode?: 'safeStorage' | 'localFileKey';
  storageBackend?: string;
  isOsBackedStorage?: boolean;
};

type ClipboardStatus = {
  level: 'info' | 'error';
  message: string;
};

type WebSearchToolResult = ChutesWebSearchResult & {
  snippetLabel: string;
  contentSource: 'full_page_source_material' | 'search_result_snippet';
  articleLabel?: string;
};

type WebSearchToolOutput = {
  ok: true;
  tool: 'web_search';
  query: string;
  source: 'live_web_search';
  provider: string;
  fetchedAt: string;
  mode: 'deep_search' | 'snippet_search';
  deepSearch: boolean;
  status: string;
  guidance: string;
  extractedCount: number;
  extractionAttemptedCount: number;
  totalResults: number;
  errors: number;
  results: WebSearchToolResult[];
};

const EMPTY_API_KEY_STATUS: ApiKeyStatus = {
  hasApiKey: false,
  hasStoredKey: false,
  source: 'none',
  canPersist: true,
};

const WELCOME_MESSAGE = {
  role: 'assistant',
  content:
    'Welcome to Chutes E2EE Chat. Your messages are encrypted end-to-end using ML-KEM-768 + ChaCha20-Poly1305. Only the TEE GPU instance can decrypt your prompts.\n\nI learn from every conversation. Click the brain icon to see what I remember. I also handle hiccups automatically so we never lose momentum.',
};

function getErrorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

function buildWebSearchToolOutput(query: string, result: ChutesWebSearchResponse): WebSearchToolOutput {
  const results = result.results || [];
  const totalResults = result.totalResults ?? results.length;
  const extractedCount = result.extractedCount ?? results.filter((item) => Boolean(item.article)).length;
  const extractionAttemptedCount = result.extractionAttemptedCount ?? (result.deepSearch ? Math.min(totalResults, 3) : 0);
  const errors = result.errors ?? Math.max(extractionAttemptedCount - extractedCount, 0);
  const deepSearch = Boolean(result.deepSearch);
  const status = deepSearch
    ? `Deep search: ${extractedCount}/${extractionAttemptedCount} pages read${errors ? `, ${errors} unavailable` : ''}`
    : `Snippet search: ${totalResults} ${totalResults === 1 ? 'result' : 'results'}`;

  return {
    ok: true,
    tool: 'web_search',
    query,
    source: 'live_web_search',
    provider: result.provider || 'web search',
    fetchedAt: result.fetchedAt || new Date().toISOString(),
    mode: deepSearch ? 'deep_search' : 'snippet_search',
    deepSearch,
    status,
    guidance: deepSearch
      ? 'When a result has article content, treat article as full-page source material and prefer it over the snippet. Use snippets only when article is absent.'
      : 'Only search result snippets were fetched. Do not imply the full page was read unless article content is present.',
    extractedCount,
    extractionAttemptedCount,
    totalResults,
    errors,
    results: results.map((item): WebSearchToolResult => ({
      ...item,
      snippetLabel: 'Search result snippet',
      contentSource: item.article ? 'full_page_source_material' : 'search_result_snippet',
      ...(item.article
        ? {
            articleLabel: item.articleSource === 'direct_fetch'
              ? 'Full-page source material extracted directly from this search result'
              : 'Full-page source material extracted via Jina Reader from this search result',
          }
        : {}),
    })),

  };
}

function isCompatibleChatModel(entry: ChutesModelMetadata) {
  const inputModalities = Array.isArray(entry.inputModalities) ? entry.inputModalities : ['text'];
  const outputModalities = Array.isArray(entry.outputModalities) ? entry.outputModalities : ['text'];
  return Boolean(entry.id) && Boolean(entry.chuteId) && Boolean(entry.confidentialCompute) &&
    inputModalities.includes('text') &&
    outputModalities.includes('text');
}

export default function ChatPage() {
  const [, bumpMemoryRevision] = useState(0);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [deepSearchEnabled, setDeepSearchEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streamStage, setStreamStage] = useState<StreamStage>('idle');
  const [model, setModelState] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState('');
  const [modelMetadata, setModelMetadata] = useState<Record<string, ChutesModelMetadata>>({});
  const [modelStats, setModelStats] = useState<Record<string, ChutesModelStats>>({});
  const [modelStatsLoading, setModelStatsLoading] = useState(false);
  const [modelStatsError, setModelStatsError] = useState('');
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [highlightedModelIndex, setHighlightedModelIndex] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>(EMPTY_API_KEY_STATUS);
  const [apiKeyError, setApiKeyError] = useState('');
  const [clipboardStatus, setClipboardStatus] = useState<ClipboardStatus | null>(null);
  const [currentStatus, setCurrentStatus] = useState<MessageStatus | undefined>();
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const modelManuallySelectedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const retryCountRef = useRef(0);
  const clipboardImagePasteInFlightRef = useRef(false);
  const pasteEventHandledRef = useRef(false);
  const memoryStoreRef = useRef<MemoryStore>(new MemoryStore());
  const addToolOutputRef = useRef<any>(null);
  const chatConfigRef = useRef<ChutesChatConfig>({
    model: '',
    toolsEnabled: true,
    includeImages: false,
  });

  const selectedModelMeta = modelMetadata[model];
  const selectedModelAcceptsImages = selectedModelMeta?.inputModalities?.includes('image') ?? false;
  const selectedModelStats = modelStats[model];

  const chatTransport = useMemo(
    () => new ChutesChatTransport({ getConfig: () => chatConfigRef.current }),
    [],
  );

  const getCurrentChatConfig = useCallback(
    (): ChutesChatConfig => ({
      model,
      toolsEnabled: webSearchEnabled,
      includeImages: selectedModelAcceptsImages,
    }),
    [model, selectedModelAcceptsImages, webSearchEnabled],
  );

  const getToolResultContinuationConfig = useCallback(
    (): ChutesChatConfig => ({
      ...chatConfigRef.current,
      toolsEnabled: false,
    }),
    [],
  );

  const refreshMemoryUi = useCallback(() => {
    bumpMemoryRevision((revision) => revision + 1);
  }, []);

  const chat = useChat<ChutesUIMessage>({
    transport: chatTransport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (toolCall.dynamic) return;

      // ----- Memory tool -----
      if ((toolCall.toolName as string) === 'memory') {
        const input = toolCall.input as unknown as {
          action: string;
          target: string;
          content?: string;
          old_text?: string;
        };
        const store = memoryStoreRef.current;
        const target = (input.target === 'user' ? 'user' : 'memory') as 'memory' | 'user';
        let result: { success: boolean; error?: string; usage?: string; currentEntries?: string[] };

        if (input.action === 'add') {
          result = store.add(input.content || '', target);
        } else if (input.action === 'replace') {
          result = store.replace(target, input.old_text || '', input.content || '');
        } else if (input.action === 'remove') {
          result = store.remove(target, input.old_text || '');
        } else {
          result = { success: false, error: `Unknown memory action '${input.action}'.` };
        }

        if (result.success) refreshMemoryUi();

        addToolOutputRef.current?.({
          tool: 'memory',
          toolCallId: toolCall.toolCallId,
          output: {
            ok: result.success,
            tool: 'memory',
            action: input.action,
            target,
            ...(result.success
              ? {
                  usage: result.usage,
                  currentEntries: result.currentEntries,
                }
              : { error: result.error }),
          },
          options: {
            metadata: { ...chatConfigRef.current, toolsEnabled: false },
            body: { ...chatConfigRef.current, toolsEnabled: false },
          },
        });
        return;
      }

      // ----- Web search tool -----
      if ((toolCall.toolName as string) !== 'web_search') return;

      const input = toolCall.input as { query?: string };
      const query = typeof input?.query === 'string' ? input.query.trim() : '';
      const continuationConfig = getToolResultContinuationConfig();
      if (!query) {
        addToolOutputRef.current?.({
          tool: 'web_search',
          toolCallId: toolCall.toolCallId,
          state: 'output-error',
          errorText: 'web_search requires a non-empty query string.',
          options: {
            metadata: continuationConfig,
            body: continuationConfig,
          },
        });
        return;
      }

      let result: Awaited<ReturnType<typeof window.chutes.webSearch>>;
      try {
        result = await window.chutes.webSearch(query, deepSearchEnabled);
      } catch (err: unknown) {
        result = { ok: false, error: getErrorMessage(err, 'Web search failed.') };
      }
      addToolOutputRef.current?.({
        tool: 'web_search',
        toolCallId: toolCall.toolCallId,
        ...(result.ok
          ? {
              output: buildWebSearchToolOutput(query, result),
            }
          : {
              state: 'output-error',
              errorText: result.error || 'Web search failed.',
            }),
        options: {
          metadata: continuationConfig,
          body: continuationConfig,
        },
      });
    },
  });

  const {
    messages: aiMessages,
    sendMessage: sendAiMessage,
    regenerate: regenerateAiMessage,
    stop: stopAiMessage,
    status: aiStatus,
    error: aiError,
    addToolOutput,
    setMessages: setAiMessages,
    clearError: clearAiError,
  } = chat;

  useEffect(() => {
    chatConfigRef.current = getCurrentChatConfig();
  }, [getCurrentChatConfig]);

  useEffect(() => {
    addToolOutputRef.current = addToolOutput;
  }, [addToolOutput]);

  useEffect(() => {
    const loading = aiStatus === 'submitted' || aiStatus === 'streaming';
    setIsLoading(loading);

    if (aiStatus === 'submitted') {
      setStreamStage('connecting');
      setCurrentStatus({
        done: false,
        action: 'connecting',
        description: 'Connecting to Chutes TEE...',
        timestamp: Date.now(),
      });
    } else if (aiStatus === 'streaming') {
      setStreamStage('streaming');
      setCurrentStatus({
        done: false,
        action: 'streaming',
        description: 'Streaming response...',
        timestamp: Date.now(),
      });
    } else {
      setStreamStage('idle');
      setCurrentStatus(undefined);
    }
  }, [aiStatus]);

  const chooseInitialModel = useCallback((availableModels: string[]) => {
    if (availableModels.length === 0) {
      setModelState('');
      return;
    }

    setModelState((currentModel) => {
      if (availableModels.includes(currentModel)) return currentModel;

      let storedModel = '';
      if (typeof window !== 'undefined') {
        try {
          storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY) || '';
        } catch {
          /* ignore unavailable storage */
        }
      }

      if (storedModel && availableModels.includes(storedModel)) return storedModel;

      return availableModels[0]!;
    });
  }, []);

  const setModel = useCallback((nextModel: string) => {
    setModelState(nextModel);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(MODEL_STORAGE_KEY, nextModel);
      } catch {
        /* ignore unavailable storage */
      }
    }
  }, []);

  const selectModel = useCallback((nextModel: string) => {
    setModel(nextModel);
    setModelQuery('');
    setHighlightedModelIndex(0);
    setShowModelMenu(false);
    modelInputRef.current?.blur();
    modelManuallySelectedRef.current = true;
  }, [setModel]);

  const applyApiKeyStatus = useCallback((res: any) => {
    if (!res?.ok) {
      setApiKeyError(res?.error || 'Could not read API key status.');
      return;
    }

    const nextStatus: ApiKeyStatus = {
      hasApiKey: Boolean(res.hasApiKey),
      hasStoredKey: Boolean(res.hasStoredKey),
      source: res.source || 'none',
      canPersist: res.canPersist !== false,
      storageMode: res.storageMode,
      storageBackend: res.storageBackend,
      isOsBackedStorage: Boolean(res.isOsBackedStorage),
    };

    setApiKeyStatus(nextStatus);
    setApiKeySaved(nextStatus.hasApiKey);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY);
      if (storedModel) setModelState(storedModel);
    } catch {
      /* ignore unavailable storage */
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const storedDeepSearch = window.localStorage.getItem(DEEP_SEARCH_STORAGE_KEY);
      if (storedDeepSearch === 'true') setDeepSearchEnabled(true);
      if (storedDeepSearch === 'false') setDeepSearchEnabled(false);
    } catch {
      /* ignore unavailable storage */
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(DEEP_SEARCH_STORAGE_KEY, String(deepSearchEnabled));
    } catch {
      /* ignore unavailable storage */
    }
  }, [deepSearchEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!window.chutes) {
      setModelsLoading(false);
      setModelsError('Chutes bridge unavailable.');
      chooseInitialModel([]);
      return;
    }

    let cancelled = false;
    setModelsLoading(true);
    setModelsError('');

    window.chutes.models()
      .then((res: any) => {
        if (cancelled) return;

        if (!res.ok) {
          setModels([]);
          setModelMetadata({});
          setModelsError(res.error || 'Could not load Chutes models.');
          chooseInitialModel([]);
          return;
        }

        const metadata = Array.isArray(res.metadata) ? res.metadata : [];
        const metadataById = Object.fromEntries(
          metadata.map((entry: ChutesModelMetadata) => [entry.id, entry]),
        );
        const discoveredModels = metadata
          .filter(isCompatibleChatModel)
          .map((entry: ChutesModelMetadata) => entry.id);

        setModelMetadata(metadataById);
        setModels(discoveredModels);
        chooseInitialModel(discoveredModels);

        if (discoveredModels.length === 0) {
          setModelsError('No Chutes E2EE text models are currently advertised.');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setModels([]);
        setModelMetadata({});
        setModelsError(getErrorMessage(err, 'Could not load Chutes models.'));
        chooseInitialModel([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chooseInitialModel]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;

    let cancelled = false;
    let interval: number | undefined;
    const loadStats = () => {
      setModelStatsLoading(true);
      window.chutes.modelStats()
        .then((res) => {
          if (cancelled) return;
          if (res.ok && res.stats) {
            setModelStats(res.stats);
            setModelStatsError('');
          } else {
            setModelStatsError(res.error || 'Stats unavailable');
          }
        })
        .catch((err) => {
          if (!cancelled) setModelStatsError(err?.message || 'Stats unavailable');
        })
        .finally(() => {
          if (!cancelled) setModelStatsLoading(false);
        });
    };

    const timer = window.setTimeout(() => {
      loadStats();
      interval = window.setInterval(loadStats, 120_000);
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (interval) window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;
    window.chutes.getApiKeyStatus('chutes')
      .then(applyApiKeyStatus)
      .catch((err) => {
        setApiKeyError(err?.message || 'Could not read API key status.');
      });
  }, [applyApiKeyStatus]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
        setModelQuery('');
        setHighlightedModelIndex(0);
      }
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const sortedModels = useMemo(() => sortModelsByStats(models, modelStats), [models, modelStats]);

  useEffect(() => {
    if (sortedModels.length === 0 || modelManuallySelectedRef.current) return;

    let storedModel = '';
    if (typeof window !== 'undefined') {
      try {
        storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY) || '';
      } catch {
        /* ignore unavailable storage */
      }
    }

    if (storedModel && sortedModels.includes(storedModel)) return;

    const topModel = sortedModels[0]!;
    if (model !== topModel) {
      setModelState(topModel);
    }
  }, [model, sortedModels]);

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return sortedModels;
    const terms = query.split(/\s+/).filter(Boolean);
    return sortedModels.filter((m) => {
      const lower = m.toLowerCase();
      return terms.every((term) => lower.includes(term));
    });
  }, [modelQuery, sortedModels]);

  useEffect(() => {
    setHighlightedModelIndex((idx) => {
      if (filteredModels.length === 0) return 0;
      return Math.min(idx, filteredModels.length - 1);
    });
  }, [filteredModels.length]);

  const openModelMenu = useCallback(() => {
    const currentIndex = filteredModels.indexOf(model);
    setHighlightedModelIndex(currentIndex >= 0 ? currentIndex : 0);
    setShowModelMenu(true);
  }, [filteredModels, model]);

  const handleModelKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setShowModelMenu(true);
      setHighlightedModelIndex((idx) => {
        if (filteredModels.length === 0) return 0;
        return (idx + 1) % filteredModels.length;
      });
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setShowModelMenu(true);
      setHighlightedModelIndex((idx) => {
        if (filteredModels.length === 0) return 0;
        return (idx - 1 + filteredModels.length) % filteredModels.length;
      });
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const nextModel = filteredModels[highlightedModelIndex] || filteredModels[0];
      if (nextModel) selectModel(nextModel);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setShowModelMenu(false);
      setModelQuery('');
      setHighlightedModelIndex(0);
      modelInputRef.current?.blur();
    }
  }, [filteredModels, highlightedModelIndex, selectModel]);

  useEffect(() => {
    if (!showModelMenu || filteredModels.length === 0) return;
    document
      .getElementById(`model-option-${highlightedModelIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [filteredModels.length, highlightedModelIndex, showModelMenu]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

  const sendMessage = useCallback(async () => {
    const attachmentSnapshot = attachments;
    const inputSnapshot = input;
    const enteredText = input.trim();
    const text = enteredText || (attachmentSnapshot.length > 0 ? 'Please review the attached file(s).' : '');
    if ((!text && attachmentSnapshot.length === 0) || isLoading || modelsLoading || !model) return;
    retryCountRef.current = 0;
    clearAiError();

    const { entries: recalledEntries, contextBlock: memoryContext } = memoryStoreRef.current.recallFor(text);
    const memoryForUI: MessageMemory[] = recalledEntries.map((m) => ({
      source: 'recalled',
      label: m.label,
      content: m.content,
      id: m.id,
    }));

    setInput('');
    setAttachments([]);
    setStreamStage('encrypting');
    setCurrentStatus({
      done: false,
      action: 'encrypting',
      description: 'Encrypting message for TEE...',
      timestamp: Date.now(),
    });

    try {
      const config = getCurrentChatConfig();
      await sendAiMessage(
        {
          parts: [
            { type: 'text', text },
            ...attachmentsToFileParts(attachmentSnapshot),
          ],
          metadata: {
            attachments: attachmentSnapshot,
            memoryContext: memoryForUI,
            memoryContextText: memoryContext,
            ...config,
          },
        },
        { body: config },
      );
    } catch (err: unknown) {
      setInput(inputSnapshot);
      setAttachments(attachmentSnapshot);
      setIsLoading(false);
      setStreamStage('idle');
      setCurrentStatus({
        done: true,
        action: 'error',
        description: getErrorMessage(err, 'Unexpected error'),
        timestamp: Date.now(),
        level: 'error',
      });
    }
  }, [
    modelsLoading,
    attachments,
    input,
    model,
    isLoading,
    sendAiMessage,
    getCurrentChatConfig,
    clearAiError,
    setInput,
    setAttachments,
    setStreamStage,
    setCurrentStatus,
  ]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    try {
      const nextAttachments = await Promise.all(
        files.map(async (file, index): Promise<MessageAttachment> => {
          const fallbackName = file.type.startsWith('image/')
            ? `pasted-screenshot-${Date.now()}-${index + 1}.${extensionForMimeType(file.type)}`
            : `pasted-file-${Date.now()}-${index + 1}`;
          const base = {
            id: crypto.randomUUID(),
            name: file.name || fallbackName,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
          };

          if (file.type.startsWith('image/')) {
            return {
              ...base,
              kind: 'image',
              dataUrl: await readFileAsDataUrl(file),
            };
          }

          if (isTextFile(file)) {
            const text = await readFileAsText(file);
            return {
              ...base,
              kind: 'text',
              text: text.slice(0, 120_000),
            };
          }

          return { ...base, kind: 'unsupported' };
        }),
      );

      setAttachments((prev) => [...prev, ...nextAttachments]);
      setClipboardStatus(null);
    } catch (err: unknown) {
      setClipboardStatus({
        level: 'error',
        message: getErrorMessage(err, 'Could not read the selected file.'),
      });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return;
    addFiles(Array.from(files));
  }, [addFiles]);

  const addNativeClipboardImage = useCallback(async () => {
    let result: Awaited<ReturnType<typeof window.chutes.clipboardImage>>;
    try {
      result = await window.chutes.clipboardImage();
    } catch (err: unknown) {
      setClipboardStatus({ level: 'error', message: getErrorMessage(err, 'Could not read clipboard.') });
      return false;
    }

    if (!result.ok) {
      setClipboardStatus({ level: 'error', message: result.error || 'Could not read clipboard.' });
      return false;
    }

    if (!result.hasImage || !result.dataUrl) {
      setClipboardStatus({ level: 'error', message: 'No screenshot image found in the clipboard.' });
      return false;
    }

    setAttachments((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: `pasted-screenshot-${Date.now()}.png`,
        mimeType: result.mimeType || 'image/png',
        size: result.size || 0,
        kind: 'image',
        dataUrl: result.dataUrl,
      },
    ]);
    setClipboardStatus(null);
    return true;
  }, []);

  const addClipboardImages = useCallback(async () => {
    if (clipboardImagePasteInFlightRef.current) return false;
    clipboardImagePasteInFlightRef.current = true;
    setClipboardStatus({ level: 'info', message: 'Checking clipboard for a screenshot...' });

    try {
      const asyncClipboardFiles = await readClipboardImageFiles();
      if (asyncClipboardFiles.length > 0) {
        await addFiles(asyncClipboardFiles);
        setClipboardStatus(null);
        return true;
      }

      return await addNativeClipboardImage();
    } finally {
      window.setTimeout(() => {
        clipboardImagePasteInFlightRef.current = false;
      }, 250);
    }
  }, [addFiles, addNativeClipboardImage]);

  useEffect(() => {
    const handleDocumentPaste = (event: ClipboardEvent) => {
      pasteEventHandledRef.current = true;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;

      const files = clipboardFilesFromData(event.clipboardData);
      if (files.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        addFiles(files);
        inputRef.current?.focus();
        return;
      }

      if (event.clipboardData?.getData('text/plain') && !clipboardLooksLikeImage(event.clipboardData)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      addClipboardImages().then((added) => {
        if (added) inputRef.current?.focus();
      });
    };

    document.addEventListener('paste', handleDocumentPaste);
    return () => document.removeEventListener('paste', handleDocumentPaste);
  }, [addClipboardImages, addFiles]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isPasteShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';
      if (!isPasteShortcut) return;

      pasteEventHandledRef.current = false;
      window.setTimeout(() => {
        if (pasteEventHandledRef.current) return;
        addClipboardImages().then((added) => {
          if (added) inputRef.current?.focus();
        });
      }, 60);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [addClipboardImages]);

  const handleComposerPaste = useCallback((event: React.ClipboardEvent) => {
    pasteEventHandledRef.current = true;
    const clipboardFiles = clipboardFilesFromData(event.clipboardData);
    if (clipboardFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      addFiles(clipboardFiles);
      return;
    }

    const text = event.clipboardData.getData('text/plain');
    if (text && !clipboardLooksLikeImage(event.clipboardData)) return;

    event.preventDefault();
    event.stopPropagation();
    addClipboardImages();
  }, [addClipboardImages, addFiles]);

  const abort = useCallback(() => {
    stopAiMessage();
    setIsLoading(false);
    setStreamStage('idle');
    setCurrentStatus(undefined);
  }, [stopAiMessage]);

  /**
   * Retry the last assistant message after a failure.
   *
   * NOTE: This uses the *current* chat config (model, tools, images) at the
   * moment retry is clicked. If the user changed the model between the original
   * request and the retry, the retry will run with the newly selected model.
   * This is intentional — the user expects the current settings to apply.
   */
  const retryLastMessage = useCallback(() => {
    retryCountRef.current += 1;
    if (retryCountRef.current > MAX_RETRIES) {
      return;
    }
    regenerateAiMessage({ body: getCurrentChatConfig() });
  }, [getCurrentChatConfig, regenerateAiMessage]);

  const regenerateMessage = useCallback(
    (messageId?: string) => {
      retryCountRef.current = 0;
      regenerateAiMessage({
        messageId,
        body: getCurrentChatConfig(),
      });
    },
    [getCurrentChatConfig, regenerateAiMessage],
  );

  const startNewConversation = useCallback(() => {
    if (isLoading) {
      stopAiMessage();
    }
    clearAiError();
    setAiMessages([]);
    setInput('');
    setAttachments([]);
    setClipboardStatus(null);
    setCurrentStatus(undefined);
    setStreamStage('idle');
    retryCountRef.current = 0;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [clearAiError, isLoading, setAiMessages, stopAiMessage]);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setApiKeyError('');
    try {
      const res = await window.chutes.saveApiKey('chutes', apiKey.trim());
      if (res.ok) {
        applyApiKeyStatus(res);
        setShowSettings(false);
        setApiKey('');
      } else {
        setApiKeyError(res.error || 'Could not save API key.');
      }
    } catch (err: unknown) {
      setApiKeyError(getErrorMessage(err, 'Could not save API key.'));
    }
  };

  const deleteKey = async () => {
    setApiKeyError('');
    try {
      const res = await window.chutes.deleteApiKey('chutes');
      if (res.ok) {
        applyApiKeyStatus(res);
        setApiKey('');
      } else {
        setApiKeyError(res.error || 'Could not delete API key.');
      }
    } catch (err: unknown) {
      setApiKeyError(getErrorMessage(err, 'Could not delete API key.'));
    }
  };

  const handleTextAreaKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const stageIndicator = () => {
    if (!isLoading || streamStage === 'idle') return null;
    const stages: { key: StreamStage; label: string; icon: React.ReactNode }[] = [
      { key: 'encrypting', label: 'Encrypting...', icon: <Lock className="w-3 h-3" /> },
      { key: 'connecting', label: 'Connecting to TEE...', icon: <Fingerprint className="w-3 h-3" /> },
      { key: 'thinking', label: 'Thinking...', icon: <Zap className="w-3 h-3" /> },
      { key: 'streaming', label: 'Streaming...', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    ];
    const currentIdx = stages.findIndex((s) => s.key === streamStage);

    return (
      <div className="flex items-center gap-3 px-4 py-2 text-xs text-[var(--text-secondary)] animate-in fade-in">
        {stages.map((s, i) => {
          const done = i < currentIdx;
          const active = i === currentIdx;
          return (
            <div key={s.key} className={cn('flex items-center gap-1 transition-opacity', active ? 'text-[var(--accent)]' : done ? 'opacity-40' : 'opacity-20')}>
              {done ? <Check className="w-3 h-3" /> : s.icon}
              <span>{s.label}</span>
              {i < stages.length - 1 && <span className="ml-1 opacity-30">/</span>}
            </div>
          );
        })}
      </div>
    );
  };

  const modelInputValue = showModelMenu ? modelQuery : model;
  const modelInputWidth = `${Math.min(Math.max(modelInputValue.length + 1, 18), 48)}ch`;

  return (
    <div className="flex h-screen flex-col bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.06),transparent_34rem),var(--bg-primary)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-6 py-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-[var(--accent)]" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Chutes E2EE Chat</h1>
          <button
            type="button"
            onClick={startNewConversation}
            className="ml-3 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/60 hover:text-[var(--text-primary)]"
            title="Start a new conversation"
          >
            <Plus className="h-3.5 w-3.5" />
            New chat
          </button>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <div className="relative" ref={menuRef}>
            <div
              role="combobox"
              aria-expanded={showModelMenu}
              aria-controls="model-options"
              aria-haspopup="listbox"
              aria-activedescendant={showModelMenu && filteredModels.length > 0 ? `model-option-${highlightedModelIndex}` : undefined}
              className="flex min-h-9 max-w-full items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors focus-within:ring-1 focus-within:ring-[var(--accent)] hover:text-[var(--text-primary)]"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  e.preventDefault();
                  modelInputRef.current?.focus();
                  openModelMenu();
                }
              }}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <input
                ref={modelInputRef}
                value={modelInputValue}
                onFocus={openModelMenu}
                onChange={(e) => {
                  setModelQuery(e.target.value);
                  setHighlightedModelIndex(0);
                  setShowModelMenu(true);
                }}
                onKeyDown={handleModelKeyDown}
                aria-autocomplete="list"
                className="bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder-[var(--text-secondary)]"
                style={{ width: modelInputWidth }}
                placeholder={modelsLoading ? 'Loading models...' : 'Search models'}
                disabled={modelsLoading && models.length === 0}
                spellCheck={false}
              />
              {modelsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />}
              <ModelStatsLine
                stats={selectedModelStats}
                loading={modelStatsLoading && !selectedModelStats}
                error={modelStatsError}
                className="hidden shrink-0 sm:inline"
              />
              <button
                type="button"
                onClick={() => {
                  modelInputRef.current?.focus();
                  if (showModelMenu) {
                    setShowModelMenu(false);
                    setModelQuery('');
                  } else {
                    openModelMenu();
                  }
                }}
                className="shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                tabIndex={-1}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            {showModelMenu && (
              <div id="model-options" role="listbox" className="absolute right-0 top-full z-50 mt-1 max-h-80 w-[min(980px,calc(100vw-2rem))] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] shadow-xl">
                {filteredModels.length > 0 ? (
                  <>
                    <div className="grid min-w-[760px] grid-cols-[minmax(22rem,1fr)_7rem_6rem_6rem_7rem_1.5rem] gap-4 border-b border-[var(--border)] px-3 py-1.5 text-[10px] uppercase text-[var(--text-secondary)] opacity-50">
                      <span>Model</span>
                      <span className="text-right">Instances</span>
                      <span className="text-right">Util</span>
                      <span className="text-right">TPS</span>
                      <span className="text-right">TTFT</span>
                      <span />
                    </div>
                    {filteredModels.map((m, i) => {
                      const active = i === highlightedModelIndex;
                      const selected = m === model;
                      return (
                        <button
                          key={m}
                          id={`model-option-${i}`}
                          role="option"
                          aria-selected={selected}
                          onMouseEnter={() => setHighlightedModelIndex(i)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => selectModel(m)}
                          className={cn(
                            'grid min-w-[760px] w-full grid-cols-[minmax(22rem,1fr)_7rem_6rem_6rem_7rem_1.5rem] items-center gap-4 px-3 py-2 text-left text-sm transition-colors',
                            active && 'bg-[var(--bg-tertiary)]',
                            selected ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
                          )}
                        >
                          <span className="whitespace-normal break-words">{m}</span>
                          <ModelStatsColumns stats={modelStats[m]} />
                          <span className="flex justify-end">
                            {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                          </span>
                        </button>
                      );
                    })}
                  </>
                ) : (
                  <div className="px-3 py-2 text-sm text-[var(--text-secondary)] opacity-70">
                    {modelsLoading ? 'Loading models...' : modelsError || 'No matching models'}
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={() => setShowMemoryPanel((v) => !v)}
            className="relative rounded-lg bg-[var(--bg-tertiary)] p-2 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            title="View saved memories"
          >
            <Brain className="h-4 w-4" />
            {memoryStoreRef.current.getMemories().length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--accent)]" />
            )}
          </button>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className="relative rounded-lg bg-[var(--bg-tertiary)] p-2 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            title="Open settings"
          >
            <Settings className="h-4 w-4" />
            {!apiKeySaved && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" />}
          </button>
        </div>
      </header>

      {!apiKeySaved && (
        <div className="flex items-center justify-center gap-2 border-b border-red-900/50 bg-red-950/60 px-6 py-2 text-xs text-red-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>No API key configured.</span>
          <button onClick={() => setShowSettings(true)} className="underline hover:text-red-200">
            Open Settings to add your Chutes API key
          </button>
        </div>
      )}

      {showSettings && (
        <SettingsDialog
          apiKey={apiKey}
          apiKeySaved={apiKeySaved}
          apiKeyStatus={apiKeyStatus}
          apiKeyError={apiKeyError}
          deepSearchEnabled={deepSearchEnabled}
          settingsRef={settingsRef}
          onApiKeyChange={setApiKey}
          onToggleDeepSearch={() => setDeepSearchEnabled((enabled) => !enabled)}
          onClose={() => setShowSettings(false)}
          onSave={saveKey}
          onDelete={deleteKey}
          memoryStore={memoryStoreRef.current}
          onMemoryStateChange={refreshMemoryUi}
        />
      )}

      {showMemoryPanel && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-end pr-4 pt-20">
          <MemoryPanel
            store={memoryStoreRef.current}
            onClose={() => setShowMemoryPanel(false)}
            onStateChange={refreshMemoryUi}
          />
        </div>
      )}

      <Conversation>
        <ConversationContent autoScroll className="flex flex-col gap-1 px-6 py-6">
          {aiMessages.length === 0 && <AssistantWelcome />}

          {aiMessages.map((message, index) => (
            <ChatMessage
              key={message.id}
              message={message}
              isLast={index === aiMessages.length - 1}
              status={aiStatus}
              error={aiError}
              onRegenerate={() => regenerateMessage(message.id)}
            />
          ))}

          {aiError && aiStatus === 'error' && (
            <div className="mx-auto w-full max-w-[980px] rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-200">
              <div className="mb-2 flex items-center gap-2">
                <WifiOff className="h-4 w-4" />
                <span>{aiError.message}</span>
              </div>
              <button onClick={retryLastMessage} className="inline-flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]">
                <RotateCcw className="h-3.5 w-3.5" />
                Retry
              </button>
            </div>
          )}

          {currentStatus && isLoading && (
            <div className="mx-auto w-full max-w-[980px]">
              <LiveStatusCard status={currentStatus} />
            </div>
          )}

          <div className="mx-auto w-full max-w-[980px]">{stageIndicator()}</div>
        </ConversationContent>
        <ConversationScrollButton />


        <div className="border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3">
          <ChatComposer
            input={input}
            attachments={attachments}
            clipboardStatus={clipboardStatus}
            canSend={Boolean(model) && !modelsLoading}
            sendDisabledReason={
              modelsLoading
                ? 'Models are still loading.'
                : model
                  ? undefined
                  : modelsError || 'No compatible Chutes model is available.'
            }
            isLoading={isLoading}
            webSearchEnabled={webSearchEnabled}
            deepSearchEnabled={deepSearchEnabled}
            selectedModelAcceptsImages={selectedModelAcceptsImages}
            inputRef={inputRef}
            fileInputRef={fileInputRef}
            onInputChange={setInput}
            onSubmit={sendMessage}
            onKeyDown={handleTextAreaKeyDown}
            onPaste={handleComposerPaste}
            onFiles={handleFiles}
            onRemoveAttachment={removeAttachment}
            onToggleWebSearch={() => setWebSearchEnabled((enabled) => !enabled)}
            onToggleDeepSearch={() => setDeepSearchEnabled((enabled) => !enabled)}
            onAbort={abort}
          />
        </div>
      </Conversation>
    </div>
  );
}

function AssistantWelcome() {
  return (
    <div className="mx-auto flex w-full max-w-[980px] gap-3 py-2.5">
      <MessageAvatar from="assistant" icon={<Bot className="h-4 w-4" />} />
      <div className="max-w-2xl rounded-2xl rounded-bl-md border border-[var(--border)] bg-[var(--bg-secondary)]/90 px-4 py-3 text-sm leading-relaxed text-[var(--text-primary)] shadow-lg shadow-black/10">
        <p>{WELCOME_MESSAGE.content.split('\n\n')[0]}</p>
        <p className="mt-4">{WELCOME_MESSAGE.content.split('\n\n')[1]}</p>
      </div>
    </div>
  );
}

function ChatMessage({
  message,
  isLast,
  status,
  error,
  onRegenerate,
}: {
  message: ChutesUIMessage;
  isLast: boolean;
  status: string;
  error?: Error;
  onRegenerate: () => void;
}) {
  const isStreaming = isLast && (status === 'submitted' || status === 'streaming');
  if (message.role === 'user') {
    return <UserMessage message={message} />;
  }
  return (
    <AssistantMessage
      message={message}
      isStreaming={isStreaming}
      isError={isLast && status === 'error'}
      error={error}
      onRegenerate={onRegenerate}
    />
  );
}

function UserMessage({ message }: { message: ChutesUIMessage }) {
  const metadata = message.metadata as ChutesMessageMetadata | undefined;
  const attachments = metadata?.attachments ?? [];
  const text = collectText(message.parts);

  return (
    <AIMessage from="user" className="mx-auto max-w-[980px]">
      <MessageContent from="user">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <AttachmentPill key={attachment.id} attachment={attachment} compact />
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{text}</div>
      </MessageContent>
      <MessageAvatar from="user" icon={<User className="h-4 w-4" />} />
    </AIMessage>
  );
}

function AssistantMessage({
  message,
  isStreaming,
  isError,
  error,
  onRegenerate,
}: {
  message: ChutesUIMessage;
  isStreaming: boolean;
  isError: boolean;
  error?: Error;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const metadata = message.metadata as ChutesMessageMetadata | undefined;
  const reasoning = collectReasoning(message.parts);
  const text = collectText(message.parts);
  const toolParts = collectToolParts(message.parts);
  const sources = extractSources(toolParts);
  const showEmpty = !text && !reasoning && toolParts.length === 0;
  const webSearchParts = toolParts.filter((part) => part.toolName === 'web_search');
  const otherToolParts = toolParts.filter((part) => part.toolName !== 'web_search');
  const otherStatusHistory = toolPartsToStatusHistory(otherToolParts);
  const hasWebSearch = webSearchParts.length > 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore clipboard failures */
    }
  };

  return (
    <AIMessage from="assistant" className="mx-auto max-w-[980px]">
      <MessageAvatar from="assistant" icon={<Bot className="h-4 w-4" />} />

      <div className="min-w-[120px] max-w-[min(86%,56rem)] flex-1">
        {metadata?.memoryContext && metadata.memoryContext.length > 0 && (
          <MemoryRecallFencing
            memories={metadata.memoryContext.map((mc) => ({ label: mc.label, content: mc.content }))}
          />
        )}

        {otherStatusHistory.length > 0 && <StatusTimeline history={otherStatusHistory} compact={!text} />}

        {hasWebSearch ? (
          <WebSearchResearchPanel
            parts={webSearchParts}
            reasoning={reasoning}
            isStreaming={isStreaming}
            sources={sources}
          />
        ) : reasoning ? (
          <Reasoning isStreaming={isStreaming && !text} chars={reasoning.length} defaultOpen={isStreaming}>
            <ReasoningTrigger />
            <ReasoningContent>{reasoning}</ReasoningContent>
          </Reasoning>
        ) : null}

        {otherToolParts.map((part) => (
          <Tool key={part.toolCallId} state={part.state} isError={part.state === 'output-error'}>
            <ToolHeader name={part.toolName} state={part.state} isError={part.state === 'output-error'} />
            {part.state === 'input-available' && part.input?.query && (
              <ToolContent>{String(part.input.query)}</ToolContent>
            )}
            {part.state === 'output-error' && part.errorText && (
              <ToolContent>{part.errorText}</ToolContent>
            )}
          </Tool>
        ))}

        {!hasWebSearch && <Sources sources={sources} />}

        {text && (
          <MessageContent from="assistant" variant="flat">
            <MessageResponse isStreaming={isStreaming}>{text}</MessageResponse>
          </MessageContent>
        )}

        {showEmpty && isStreaming && (
          <MessageContent from="assistant">
            <span className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
              Streaming...
            </span>
          </MessageContent>
        )}

        {isError && !text && (
          <MessageContent from="assistant" className="border border-red-900/60 bg-red-950/30">
            <ErrorMessage content={error?.message || 'Something went wrong.'} />
          </MessageContent>
        )}

        {!isStreaming && text && (
          <div className="mt-1.5 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
            <button onClick={copy} className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]" title="Copy to clipboard">
              {copied ? <Check className="h-3 w-3 text-[var(--accent)]" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={onRegenerate} className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]" title="Regenerate response">
              <RotateCcw className="h-3 w-3" />
              Regenerate
            </button>
          </div>
        )}
      </div>
    </AIMessage>
  );
}

function WebSearchResearchPanel({
  parts,
  reasoning,
  isStreaming,
  sources,
}: {
  parts: ReturnType<typeof collectToolParts>;
  reasoning: string;
  isStreaming: boolean;
  sources: SourceItem[];
}) {
  const latest = [...parts].reverse().find((part) => part.output || part.input?.query || part.errorText) || parts[parts.length - 1];
  const summary = getWebSearchSummary(latest?.output);
  const isError = latest?.state === 'output-error';
  const isRunning = parts.some((part) => !part.state || !part.state.startsWith('output'));
  const query = latest?.input?.query;
  const title = isError ? 'Search failed' : isRunning ? 'Searching the web' : 'Web search complete';
  const detail = isError
    ? latest?.errorText || 'The search tool returned an error.'
    : summary?.status || (query ? `Looking for: ${query}` : 'Gathering live sources');

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-emerald-500/20 bg-[linear-gradient(135deg,rgba(16,185,129,0.10),rgba(18,18,18,0.88))] shadow-sm shadow-black/10">
      <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-2.5">
          <span className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border',
            isError
              ? 'border-red-900/60 bg-red-950/40 text-red-300'
              : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
          )}>
            {isError ? (
              <AlertTriangle className="h-4 w-4" />
            ) : isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">{detail}</div>
            {query && (
              <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-xs text-[var(--text-secondary)]">
                <Search className="h-3 w-3 shrink-0" />
                <span className="truncate">{query}</span>
              </div>
            )}
          </div>
        </div>
        {summary && (
          <div className="flex shrink-0 flex-wrap gap-1.5 sm:justify-end">
            <SearchMetric label="Results" value={summary.totalResults.toLocaleString()} />
            <SearchMetric
              label={summary.deepSearch ? 'Pages read' : 'Mode'}
              value={summary.deepSearch ? `${summary.extractedCount}/${summary.extractionAttemptedCount}` : 'Snippets'}
            />
            <SearchMetric label="Sources" value={(sources.length || summary.totalResults).toLocaleString()} />
          </div>
        )}
      </div>

      {reasoning && (
        <Reasoning isStreaming={isStreaming} chars={reasoning.length} defaultOpen className="mx-3 mb-3 border-emerald-500/15 bg-black/15">
          <ReasoningTrigger>{isStreaming ? 'Thinking through sources' : 'Reasoning through sources'}</ReasoningTrigger>
          <ReasoningContent>{reasoning}</ReasoningContent>
        </Reasoning>
      )}

      {sources.length > 0 && <Sources sources={sources} className="mx-3 mb-3 border-[var(--border)]/70 bg-black/10" />}
    </div>
  );
}
function SearchMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-20 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-right">
      <div className="text-[10px] uppercase text-[var(--text-secondary)] opacity-70">{label}</div>
      <div className="text-xs font-medium text-[var(--text-primary)]">{value}</div>
    </div>
  );
}

function ChatComposer({
  input,
  attachments,
  clipboardStatus,
  canSend,
  sendDisabledReason,
  isLoading,
  webSearchEnabled,
  deepSearchEnabled,
  selectedModelAcceptsImages,
  inputRef,
  fileInputRef,
  onInputChange,
  onSubmit,
  onKeyDown,
  onPaste,
  onFiles,
  onRemoveAttachment,
  onToggleWebSearch,
  onToggleDeepSearch,
  onAbort,
}: {
  input: string;
  attachments: MessageAttachment[];
  clipboardStatus: ClipboardStatus | null;
  canSend: boolean;
  sendDisabledReason?: string;
  isLoading: boolean;
  webSearchEnabled: boolean;
  deepSearchEnabled: boolean;
  selectedModelAcceptsImages: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: (event: React.ClipboardEvent) => void;
  onFiles: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  onToggleWebSearch: () => void;
  onToggleDeepSearch: () => void;
  onAbort: () => void;
}) {
  const hasImageAttachment = attachments.some((attachment) => attachment.kind === 'image');

  return (
    <div className="mx-auto max-w-[980px]">
      <PromptInput
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onPaste={onPaste}
      >
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2 border-b border-[var(--border)]/70 pb-2">
            {attachments.map((attachment) => (
              <AttachmentPill
                key={attachment.id}
                attachment={attachment}
                onRemove={() => onRemoveAttachment(attachment.id)}
              />
            ))}
            {hasImageAttachment && !selectedModelAcceptsImages && (
              <span className="self-center text-xs text-amber-300">
                Selected model does not advertise image input.
              </span>
            )}
          </div>
        )}

        {clipboardStatus && (
          <div
            className={cn(
              'mb-2 rounded-lg border px-3 py-2 text-xs',
              clipboardStatus.level === 'info' && 'border-[var(--border)] bg-black/15 text-[var(--text-secondary)]',
              clipboardStatus.level === 'error' && 'border-amber-900/60 bg-amber-950/25 text-amber-200',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span>{clipboardStatus.message}</span>
            </div>
          </div>
        )}

        <PromptInputBody>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,.txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.cc,.cpp,.h,.hpp,.css,.html,.xml,.sh,.sql,.csv,.log,.pdf"
            onChange={(event) => onFiles(event.target.files)}
          />
          <PromptInputButton onClick={() => fileInputRef.current?.click()} title="Attach files">
            <Paperclip className="h-4 w-4" />
          </PromptInputButton>
          <PromptInputButton
            onClick={onToggleWebSearch}
            active={webSearchEnabled}
            title={webSearchEnabled ? 'Web search tools enabled automatically' : 'Web search tools disabled'}
          >
            <Search className="h-4 w-4" />
          </PromptInputButton>
          {webSearchEnabled && (
            <PromptInputButton
              onClick={onToggleDeepSearch}
              active={deepSearchEnabled}
              title={deepSearchEnabled ? 'Deep search: extracts full page content' : 'Deep search off: only snippets'}
            >
              <Newspaper className="h-4 w-4" />
            </PromptInputButton>
          )}
          <PromptInputTextarea
            ref={inputRef}
            value={input}
            onChange={(event) => onInputChange(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={isLoading ? 'Interrupt to send a new message...' : 'Type an encrypted message...'}
            disabled={isLoading}
          />
          {isLoading ? (
            <PromptInputSubmit status="streaming" type="button" onClick={onAbort} title="Interrupt current request">
              <Square className="h-4 w-4" />
            </PromptInputSubmit>
          ) : (
            <PromptInputSubmit
              status="ready"
              disabled={!canSend || (!input.trim() && attachments.length === 0)}
              title={sendDisabledReason || 'Send message'}
            >
              <Send className="h-4 w-4" />
            </PromptInputSubmit>
          )}
        </PromptInputBody>
      </PromptInput>

      <p className="mt-2 text-center text-[10px] text-[var(--text-secondary)]">
        {isLoading
          ? 'Working... click stop to interrupt and redirect'
          : webSearchEnabled
            ? `Web search auto · ${deepSearchEnabled ? 'Deep search on' : 'Deep search off'} · ML-KEM-768 · ChaCha20-Poly1305 · HKDF-SHA256 - End-to-end encrypted via Chutes.ai TEE`
            : 'Web search off · ML-KEM-768 · ChaCha20-Poly1305 · HKDF-SHA256 - End-to-end encrypted via Chutes.ai TEE'}
      </p>
    </div>
  );
}

function AttachmentPill({
  attachment,
  compact = false,
  onRemove,
}: {
  attachment: MessageAttachment;
  compact?: boolean;
  onRemove?: () => void;
}) {
  return (
    <span className={cn('inline-flex max-w-full items-center gap-2 rounded-lg bg-black/20 text-xs', compact ? 'px-2 py-0.5' : 'px-2.5 py-1')}>
      {attachment.kind === 'image' ? <ImageIcon className="h-3.5 w-3.5 shrink-0" /> : <FileText className="h-3.5 w-3.5 shrink-0" />}
      {attachment.kind === 'image' && attachment.dataUrl && !compact && (
        <img src={attachment.dataUrl} alt="" className="h-7 w-7 rounded object-cover" />
      )}
      <span className="min-w-0 break-words">{attachment.name}</span>
      {!compact && <span className="shrink-0 opacity-60">{formatFileSize(attachment.size)}</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} className="shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function ErrorMessage({ content }: { content: string }) {
  const isNetwork = content.includes('Network') || content.includes('connect');
  const isAuth = content.includes('Authentication') || content.includes('401') || content.includes('403');

  return (
    <div className="flex items-center gap-2 text-red-400/90">
      {isNetwork ? <WifiOff className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
      <span>{isAuth ? 'Authentication failed. Check your API key in Settings.' : content.split('\n')[0]}</span>
    </div>
  );
}

function SettingsDialog({
  apiKey,
  apiKeySaved,
  apiKeyStatus,
  apiKeyError,
  deepSearchEnabled,
  settingsRef,
  memoryStore,
  onApiKeyChange,
  onToggleDeepSearch,
  onClose,
  onSave,
  onDelete,
  onMemoryStateChange,
}: {
  apiKey: string;
  apiKeySaved: boolean;
  apiKeyStatus: ApiKeyStatus;
  apiKeyError: string;
  deepSearchEnabled: boolean;
  settingsRef: React.RefObject<HTMLDivElement | null>;
  memoryStore: MemoryStore;
  onApiKeyChange: (value: string) => void;
  onToggleDeepSearch: () => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  onMemoryStateChange: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div ref={settingsRef} className="max-h-[calc(100vh-2rem)] w-[min(420px,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Settings</h2>
          <button onClick={onClose} className="text-[var(--text-secondary)] hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)]">
              <KeyRound className="h-3.5 w-3.5" />
              Chutes API Key
            </label>
            <p className="mb-2 text-xs text-[var(--text-secondary)]">
              Stored encrypted on this machine and used only by the Electron main process. Get yours at{' '}
              <a href="https://chutes.ai/app/api-keys" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
                chutes.ai/app/api-keys
              </a>
            </p>
            {apiKeyStatus.canPersist && apiKeyStatus.storageMode === 'localFileKey' && (
              <p className="mb-2 text-xs text-amber-300">
                Using local encrypted storage for this WSL/Linux environment. Keep your user profile files private.
              </p>
            )}
            <input
              type="password"
              value={apiKey}
              onChange={(e) => onApiKeyChange(e.target.value)}
              placeholder={apiKeySaved ? '••••••••••••••••' : 'cpk_...'}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            <button onClick={onSave} disabled={!apiKey.trim()} className="mt-2 w-full rounded-lg bg-[var(--accent)] py-2 text-sm font-medium text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40">
              {apiKeyStatus.hasStoredKey ? 'Update Stored API Key' : 'Save API Key'}
            </button>
            {apiKeyStatus.hasStoredKey && (
              <button onClick={onDelete} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-red-900/60 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-950/40">
                <Trash2 className="h-3.5 w-3.5" />
                Remove Stored API Key
              </button>
            )}
            {apiKeyError && <p className="mt-2 text-xs text-red-300">{apiKeyError}</p>}
          </div>

          {apiKeySaved && (
            <p className="flex items-center gap-1 text-xs text-[var(--accent)]">
              <Shield className="h-3 w-3" />
              {apiKeyStatus.isOsBackedStorage
                ? 'API key stored with OS-backed encryption'
                : 'API key stored with local encrypted storage'}
            </p>
          )}

          <div className="flex items-center justify-between rounded-lg bg-[var(--bg-tertiary)] px-3 py-2">
            <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
              <Newspaper className="h-3.5 w-3.5 text-[var(--accent)]" />
              Deep Search
            </div>
            <button
              onClick={onToggleDeepSearch}
              className={cn(
                'relative h-5 w-9 rounded-full transition-colors',
                deepSearchEnabled ? 'bg-[var(--accent)]' : 'bg-black/40',
              )}
              title="Toggle deep search (extracts full-page content)"
            >
              <span
                className={cn(
                  'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform',
                  deepSearchEnabled ? 'left-4.5 translate-x-0' : 'left-0.5 translate-x-0',
                )}
              />
            </button>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] opacity-70">
            When enabled, search results read available page text via Jina Reader first, then a direct no-key fallback. No extra paid provider required.
          </p>

          <div className="border-t border-[var(--border)] pt-4">
            <h3 className="mb-2 text-sm font-medium text-[var(--text-primary)]">Saved Memory</h3>
            <div className="flex flex-col gap-2">
              {memoryStore.getMemories().length === 0 ? (
                <p className="text-xs text-[var(--text-secondary)]">No memories saved yet.</p>
              ) : (
                memoryStore.getMemories().map((mem) => (
                  <div key={mem.id} className="flex items-start justify-between gap-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-xs">
                    <span className="text-[var(--text-secondary)]">{mem.content}</span>
                    <button
                      onClick={() => {
                        memoryStore.removeMemory(mem.id);
                        onMemoryStateChange();
                      }}
                      className="shrink-0 text-red-400 hover:text-red-300"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MemoryPanel({
  store,
  onClose,
  onStateChange,
}: {
  store: MemoryStore;
  onClose: () => void;
  onStateChange: () => void;
}) {
  const [memories, setMemories] = useState(store.getMemories());
  const [newMemory, setNewMemory] = useState('');

  const refresh = () => {
    setMemories(store.getMemories());
    onStateChange();
  };

  return (
    <div className="pointer-events-auto flex max-h-[70vh] w-80 flex-col gap-3 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-4 shadow-2xl animate-in fade-in">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <Brain className="h-4 w-4 text-[var(--accent)]" />
          Saved Memories
        </h3>
        <button onClick={onClose} className="rounded p-1 text-[var(--text-secondary)] transition-colors hover:bg-white/5">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-2">
        <input
          value={newMemory}
          onChange={(e) => setNewMemory(e.target.value)}
          placeholder="Add a memory..."
          className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newMemory.trim()) {
              store.addMemory(newMemory.trim(), 'memory');
              setNewMemory('');
              refresh();
            }
          }}
        />
        <button
          onClick={() => {
            if (newMemory.trim()) {
              store.addMemory(newMemory.trim(), 'memory');
              setNewMemory('');
              refresh();
            }
          }}
          className="rounded-lg bg-[var(--accent)] p-2 text-black transition-colors hover:bg-[var(--accent-hover)]"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </div>

      {memories.length === 0 ? (
        <div className="py-4 text-center text-xs text-[var(--text-secondary)]">
          No memories yet. They accumulate as we chat, or add one above.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {memories.map((mem, i) => (
            <div key={mem.id} className="group flex items-start gap-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2">
              <span className="mt-0.5 w-4 shrink-0 text-[10px] text-[var(--text-secondary)]">{i + 1}.</span>
              <span className="flex-1 text-xs leading-relaxed text-[var(--text-secondary)]">{mem.content}</span>
              <button
                onClick={() => {
                  store.removeMemory(mem.id);
                  refresh();
                }}
                className="shrink-0 rounded p-0.5 text-red-400 opacity-0 transition-all hover:bg-red-950/40 group-hover:opacity-100"
                title="Delete memory"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-[var(--border)] pt-3">
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">Skills</h4>
        {store.getSkills().length === 0 ? (
          <p className="text-[11px] text-[var(--text-secondary)] opacity-60">No skills created yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {store.getSkills().map((skill) => (
              <div key={skill.id} className="rounded-lg bg-[var(--bg-tertiary)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">{skill.name}</span>
                <span className="ml-2 text-[10px] text-[var(--text-secondary)] opacity-60">({skill.useCount} uses)</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function collectText(parts: ChutesUIMessage['parts']) {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

function collectReasoning(parts: ChutesUIMessage['parts']) {
  return parts
    .filter((part) => part.type === 'reasoning')
    .map((part) => part.text)
    .join('\n\n');
}

function collectToolParts(parts: ChutesUIMessage['parts']) {
  return parts
    .filter((part) => part.type === 'dynamic-tool' || part.type.startsWith('tool-'))
    .map((part: any) => {
      const toolCallId = part.toolCallId || part.id;
      if (!toolCallId) {
        console.warn('collectToolParts: tool part missing both toolCallId and id — skipping');
        return null;
      }
      return {
        toolCallId: String(toolCallId),
        toolName: String(part.type === 'dynamic-tool' ? part.toolName : part.type.replace(/^tool-/, '')),
        input: part.input as { query?: string } | undefined,
        output: part.output,
        errorText: part.errorText,
        state: String(part.state || ''),
      };
    })
    .filter(Boolean) as any[];
}

function extractSources(toolParts: ReturnType<typeof collectToolParts>): SourceItem[] {
  const sources = new Map<string, SourceItem>();
  for (const part of toolParts) {
    const results = (part.output as any)?.results;
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      if (typeof result?.url !== 'string') continue;

      // Sanitize URL: reject non-HTTP(S) schemes to prevent javascript: injection
      let url: string;
      try {
        const parsed = new URL(result.url.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        url = parsed.href;
      } catch {
        continue;
      }

      sources.set(url, {
        title: typeof result.title === 'string' ? result.title : url,
        url,
      });
    }
  }
  return Array.from(sources.values());
}

type WebSearchSummary = {
  status: string;
  totalResults: number;
  extractedCount: number;
  extractionAttemptedCount: number;
  errors: number;
  deepSearch: boolean;
};

function getWebSearchSummary(output: unknown): WebSearchSummary | null {
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  if (record.tool !== 'web_search') return null;

  const results = Array.isArray(record.results) ? record.results : [];
  const totalResults = readToolNumber(record.totalResults, results.length);
  const extractedCount = readToolNumber(record.extractedCount, 0);
  const extractionAttemptedCount = readToolNumber(record.extractionAttemptedCount, 0);
  const errors = readToolNumber(record.errors, 0);
  const deepSearch = record.deepSearch === true || record.mode === 'deep_search';

  const status = typeof record.status === 'string'
    ? record.status
    : deepSearch
      ? `Deep search: ${extractedCount}/${extractionAttemptedCount} pages read${errors ? `, ${errors} unavailable` : ''}`
      : `Snippet search: ${totalResults} ${totalResults === 1 ? 'result' : 'results'}`;

  return {
    status,
    totalResults,
    extractedCount,
    extractionAttemptedCount,
    errors,
    deepSearch,
  };
}

function readToolNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function toolPartsToStatusHistory(toolParts: ReturnType<typeof collectToolParts>): MessageStatus[] {
  return toolParts.map((part) => ({
    done: part.state === 'output-available' || part.state === 'output-error' || part.state === 'output-denied',
    action: part.state?.startsWith('output') ? 'tool_result' : 'tool_call',
    description:
      part.state === 'output-error'
        ? `${part.toolName} failed: ${part.errorText || 'Unknown error'}`
        : part.state?.startsWith('output')
          ? getToolResultDescription(part)
          : `Calling ${part.toolName}...`,
    timestamp: Date.now(),
    level: part.state === 'output-error' ? 'error' : part.state?.startsWith('output') ? 'success' : 'info',
  }));
}

function getToolResultDescription(part: ReturnType<typeof collectToolParts>[number]) {
  if (part.toolName === 'web_search') {
    return getWebSearchSummary(part.output)?.status || 'web_search returned a result';
  }
  return `${part.toolName} returned a result`;
}

function attachmentsToFileParts(attachments: MessageAttachment[]): FileUIPart[] {
  return attachments
    .filter((attachment) => attachment.kind === 'image' && attachment.dataUrl)
    .map((attachment) => ({
      type: 'file' as const,
      mediaType: attachment.mimeType || 'image/png',
      filename: attachment.name,
      url: attachment.dataUrl || '',
    }));
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
    reader.readAsText(file);
  });
}

function clipboardFilesFromData(data: DataTransfer | null): File[] {
  if (!data) return [];
  const itemFiles = Array.from(data.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  const files = itemFiles.length > 0 ? itemFiles : Array.from(data.files || []);
  return files.filter((file) => file.size > 0);
}

function clipboardLooksLikeImage(data: DataTransfer | null) {
  if (!data) return false;
  const types = Array.from(data.types || []).map((type) => type.toLowerCase());
  if (types.some((type) => type.includes('image') || type === 'files')) return true;
  return Array.from(data.items || []).some((item) => item.type.toLowerCase().startsWith('image/'));
}

async function readClipboardImageFiles() {
  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    return [];
  }

  try {
    const items = await navigator.clipboard.read();
    const files: File[] = [];
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      files.push(
        new File(
          [blob],
          `pasted-screenshot-${Date.now()}-${files.length + 1}.${extensionForMimeType(imageType)}`,
          { type: imageType },
        ),
      );
    }
    return files;
  } catch {
    return [];
  }
}

function extensionForMimeType(mimeType: string) {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('bmp')) return 'bmp';
  return 'png';
}

function isTextFile(file: File) {
  if (file.type.startsWith('text/')) return true;
  return /\.(txt|md|json|ya?ml|csv|log|js|jsx|ts|tsx|py|go|rs|java|c|cc|cpp|h|hpp|css|html|xml|sh|sql)$/i.test(file.name);
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatStatsNumber(value: number, options: { suffix?: string } = {}) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const formatted = value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
  return `${formatted}${options.suffix || ''}`;
}

function formatUtilization(value?: number) {
  if (!Number.isFinite(value) || value === undefined || value < 0) return null;
  return `${Math.round(value * 100)}% Util`;
}
function finiteMetric(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function modelSortMetrics(stats?: ChutesModelStats) {
  return {
    activeInstances: finiteMetric(stats?.activeInstanceCount ?? stats?.totalInstanceCount, -1),
    utilization: finiteMetric(stats?.utilizationCurrent ?? stats?.utilization5m, Number.MAX_SAFE_INTEGER),
    tps: finiteMetric(stats?.averageTps, -1),
    ttft: finiteMetric(stats?.averageTtft, Number.MAX_SAFE_INTEGER),
  };
}

function sortModelsByStats(models: string[], modelStats: Record<string, ChutesModelStats>) {
  return [...models].sort((a, b) => {
    const aStats = modelSortMetrics(modelStats[a]);
    const bStats = modelSortMetrics(modelStats[b]);

    const tpsDelta = bStats.tps - aStats.tps;
    if (tpsDelta !== 0) return tpsDelta;

    const activeDelta = bStats.activeInstances - aStats.activeInstances;
    if (activeDelta !== 0) return activeDelta;

    const utilizationDelta = aStats.utilization - bStats.utilization;
    if (utilizationDelta !== 0) return utilizationDelta;

    const ttftDelta = aStats.ttft - bStats.ttft;
    if (ttftDelta !== 0) return ttftDelta;

    return a.localeCompare(b);
  });
}


function formatModelMetrics(stats?: ChutesModelStats) {
  if (!stats) {
    return {
      instances: null,
      utilization: null,
      tps: null,
      ttft: null,
    };
  }

  return {
    instances: Number.isFinite(stats.activeInstanceCount)
      ? `${stats.activeInstanceCount} ${stats.activeInstanceCount === 1 ? 'instance' : 'instances'}`
      : null,
    utilization: formatUtilization(stats.utilizationCurrent),
    tps: formatStatsNumber(stats.averageTps),
    ttft: formatStatsNumber(stats.averageTtft, { suffix: 's' }),
  };
}

function ModelStatsColumns({ stats }: { stats?: ChutesModelStats }) {
  const metrics = formatModelMetrics(stats);
  return (
    <>
      <span className="whitespace-nowrap text-right text-[var(--text-secondary)] opacity-75">{metrics.instances || 'n/a'}</span>
      <span className="whitespace-nowrap text-right text-[var(--text-secondary)] opacity-75">{metrics.utilization || 'n/a'}</span>
      <span className="whitespace-nowrap text-right text-[var(--text-secondary)] opacity-75">{metrics.tps ? `${metrics.tps} TPS` : 'n/a'}</span>
      <span className="whitespace-nowrap text-right text-[var(--text-secondary)] opacity-75">{metrics.ttft ? `${metrics.ttft} TTFT` : 'n/a'}</span>
    </>
  );
}

function ModelStatsLine({
  stats,
  loading = false,
  error = '',
  className = '',
}: {
  stats?: ChutesModelStats;
  loading?: boolean;
  error?: string;
  className?: string;
}) {
  if (!stats) {
    if (loading) {
      return <span className={`text-[10px] leading-tight opacity-50 ${className}`}>Loading stats...</span>;
    }
    if (error) {
      return <span className={`text-[10px] leading-tight opacity-40 ${className}`}>Stats unavailable</span>;
    }
    return null;
  }

  const { instances, utilization, tps, ttft } = formatModelMetrics(stats);
  const parts = [
    instances,
    utilization,
    tps ? `${tps} TPS` : null,
    ttft ? `${ttft} TTFT` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;

  return (
    <span
      className={`whitespace-nowrap text-[10px] leading-tight text-[var(--text-secondary)] opacity-75 ${className}`}
      title={[
        stats.timestamp ? `Utilization updated ${stats.timestamp}` : '',
        stats.date ? `TPS/TTFT daily average from ${stats.date}` : '',
        stats.totalRequests ? `${stats.totalRequests.toLocaleString()} requests` : '',
      ].filter(Boolean).join(' · ')}
    >
      {parts.join(' · ')}
    </span>
  );
}

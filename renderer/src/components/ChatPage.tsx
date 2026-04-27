'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useChat } from '@ai-sdk/react';
import { lastAssistantMessageIsCompleteWithToolCalls, type FileUIPart } from 'ai';
import {
  Send,
  Square,
  Loader2,
  Bot,
  User,
  Shield,
  ChevronDown,
  Sparkles,
  Settings,
  KeyRound,
  X,
  Copy,
  Check,
  ChevronUp,
  RotateCcw,
  WifiOff,
  AlertTriangle,
  Fingerprint,
  Lock,
  Zap,
  Brain,
  Trash2,
  Paperclip,
  Search,
  FileText,
  Image as ImageIcon,
} from 'lucide-react';

import { MemoryStore } from '@/lib/memoryStore';
import { StatusTimeline, LiveStatusCard } from '@/components/StatusTimeline';
import { MemoryNudge, MemoryRecallFencing, type NudgeAction } from '@/components/MemoryNudge';
import { ChutesChatTransport, type ChutesUIMessage } from '@/lib/ai/chutesTransport';
import type { Message, MessageStatus, MessageAttachment } from '@/lib/types';

const DEFAULT_MODEL = 'Qwen/Qwen3-32B-TEE';
const FALLBACK_MODELS = [
  'Qwen/Qwen3-32B-TEE',
  'moonshotai/Kimi-K2.6-TEE',
  'moonshotai/Kimi-K2.5-TEE',
  'deepseek-ai/DeepSeek-V3-TEE',
  'deepseek-ai/DeepSeek-R1-TEE',
];

const MODEL_STORAGE_KEY = 'chutes-e2ee-chat.lastModel';
const MAX_RETRIES = 2; // manual retry button limit
const MEMORY_NUDGE_INTERVAL = 8;
const SKILL_NUDGE_INTERVAL = 12;

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

const EMPTY_API_KEY_STATUS: ApiKeyStatus = {
  hasApiKey: false,
  hasStoredKey: false,
  source: 'none',
  canPersist: true,
};

const WELCOME_MESSAGE: Message = {
  role: 'assistant',
  content:
    'Welcome to Chutes E2EE Chat. Your messages are encrypted end-to-end using ML-KEM-768 + ChaCha20-Poly1305. Only the TEE GPU instance can decrypt your prompts.\n\nI learn from every conversation — click the brain icon to see what I remember. I also handle hiccups automatically (rate limits, timeouts) so we never lose momentum.',
};

/* ─────────────────────────────────────────────────────────────────────────── */

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [streamStage, setStreamStage] = useState<StreamStage>('idle');
  const [model, setModelState] = useState(DEFAULT_MODEL);
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
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
  const [currentStatus, setCurrentStatus] = useState<MessageStatus | undefined>();
  const [nudges, setNudges] = useState<NudgeAction[]>([]);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const retryCountRef = useRef(0);
  const memoryStoreRef = useRef<MemoryStore>(new MemoryStore());
  const addToolOutputRef = useRef<any>(null);

  const selectedModelMeta = modelMetadata[model];
  const selectedModelAcceptsImages = selectedModelMeta?.inputModalities?.includes('image') ?? false;
  const chatTransport = useMemo(() => new ChutesChatTransport(), []);
  const {
    messages: aiMessages,
    sendMessage: sendAiMessage,
    regenerate: regenerateAiMessage,
    stop: stopAiMessage,
    status: aiStatus,
    error: aiError,
    addToolOutput,
  } = useChat<ChutesUIMessage>({
    transport: chatTransport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    async onToolCall({ toolCall }) {
      if (toolCall.dynamic || toolCall.toolName !== 'web_search') return;

      const input = toolCall.input as { query?: string };
      const query = typeof input?.query === 'string' ? input.query.trim() : '';
      if (!query) {
        addToolOutputRef.current?.({
          tool: 'web_search',
          toolCallId: toolCall.toolCallId,
          state: 'output-error',
          errorText: 'web_search requires a non-empty query string.',
          options: { body: { model, toolsEnabled: webSearchEnabled, includeImages: selectedModelAcceptsImages } },
        });
        return;
      }

      const result = await window.chutes.webSearch(query);
      addToolOutputRef.current?.({
        tool: 'web_search',
        toolCallId: toolCall.toolCallId,
        ...(result.ok
          ? {
              output: {
                ok: true,
                tool: 'web_search',
                query,
                source: 'live_web_search',
                provider: result.provider || 'web search',
                fetchedAt: result.fetchedAt || new Date().toISOString(),
                results: result.results || [],
              },
            }
          : {
              state: 'output-error',
              errorText: result.error || 'Web search failed.',
            }),
        options: { body: { model, toolsEnabled: webSearchEnabled, includeImages: selectedModelAcceptsImages } },
      });
    },
  });

  useEffect(() => {
    addToolOutputRef.current = addToolOutput;
  }, [addToolOutput]);

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
  }, [setModel]);

  const applyApiKeyStatus = useCallback((res: any) => {
    if (!res.ok) {
      setApiKeyError(res.error || 'Could not read API key status.');
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

  /* ── Load last selected model ───────────────────────────────────────────── */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY);
      if (storedModel) {
        setModelState(storedModel);
      }
    } catch {
      /* ignore unavailable storage */
    }
  }, []);

  /* ── Fetch available models ─────────────────────────────────────────────── */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;
    window.chutes.models().then((res: any) => {
      if (res.ok && res.models && res.models.length > 0) {
        setModels(res.models.filter((m: string) => m.includes('TEE')));
      }
      if (res.ok && res.metadata) {
        setModelMetadata(
          Object.fromEntries(
            res.metadata.map((entry: ChutesModelMetadata) => [entry.id, entry]),
          ),
        );
      }
    });
  }, []);

  /* ── Fetch recent public model stats without blocking chat ──────────────── */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;

    let cancelled = false;
    let interval: number | undefined;
    const loadStats = () => {
      setModelStatsLoading(true);
      window.chutes.modelStats().then((res) => {
        if (cancelled) return;
        if (res.ok && res.stats) {
          setModelStats(res.stats);
          setModelStatsError('');
        } else {
          setModelStatsError(res.error || 'Stats unavailable');
        }
      }).catch((err) => {
        if (!cancelled) {
          setModelStatsError(err?.message || 'Stats unavailable');
        }
      }).finally(() => {
        if (!cancelled) {
          setModelStatsLoading(false);
        }
      });
    };

    const timer = window.setTimeout(() => {
      loadStats();
      interval = window.setInterval(loadStats, 120_000);
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (interval) {
        window.clearInterval(interval);
      }
    };
  }, []);

  /* ── Load stored API key ────────────────────────────────────────────────── */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;
    window.chutes.getApiKeyStatus('chutes').then(applyApiKeyStatus);
  }, [applyApiKeyStatus]);

  /* ── Auto-scroll ────────────────────────────────────────────────────────── */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentStatus, nudges]);

  useEffect(() => {
    setMessages([
      WELCOME_MESSAGE,
      ...aiMessages.map((message, index) =>
        uiMessageToDisplayMessage(message, {
          isLast: index === aiMessages.length - 1,
          status: aiStatus,
          error: aiError,
        }),
      ),
    ]);
  }, [aiMessages, aiStatus, aiError]);

  useEffect(() => {
    const loading = aiStatus === 'submitted' || aiStatus === 'streaming';
    setIsLoading(loading);

    if (aiStatus === 'submitted') {
      setStreamStage('connecting');
      setCurrentStatus({ done: false, action: 'connecting', description: 'Connecting to Chutes TEE…', timestamp: Date.now() });
    } else if (aiStatus === 'streaming') {
      setStreamStage('streaming');
      setCurrentStatus({ done: false, action: 'streaming', description: 'Streaming response…', timestamp: Date.now() });
    } else {
      setStreamStage('idle');
      setCurrentStatus(undefined);
    }
  }, [aiStatus]);

  /* ── Close menus on outside click ───────────────────────────────────────── */
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
        setModelQuery('');
        setHighlightedModelIndex(0);
      }
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node))
        setShowSettings(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return models;
    const terms = query.split(/\s+/).filter(Boolean);
    return models.filter((m) => {
      const lower = m.toLowerCase();
      return terms.every((term) => lower.includes(term));
    });
  }, [modelQuery, models]);

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
      if (nextModel) {
        selectModel(nextModel);
      }
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

  /* ── Auto-resize textarea ───────────────────────────────────────────────── */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

  /* ── Send message ───────────────────────────────────────────────────────── */
  const sendMessage = useCallback(
    async (opts?: { retry?: boolean; overrideInput?: string }) => {
      const attachmentSnapshot = opts?.retry ? [] : attachments;
      const enteredText = (opts?.overrideInput ?? input).trim();
      const text = enteredText || (attachmentSnapshot.length > 0 ? 'Please review the attached file(s).' : '');
      if ((!text && attachmentSnapshot.length === 0) || aiStatus === 'submitted' || aiStatus === 'streaming') return;

      memoryStoreRef.current.incrementTurnCounters();

      const memoryContext = memoryStoreRef.current.getMemoryContextBlock();
      const messagesWithMemory = memoryStoreRef.current.getMemories();
      const memoryForUI: Message['memoryContext'] = messagesWithMemory.map((m) => ({
        source: 'recalled',
        label: m.target === 'user' ? 'User profile' : 'Agent memory',
        content: m.content,
        id: m.id,
      }));

      if (!opts?.retry) {
        setInput('');
        setAttachments([]);
      }

      setStreamStage('encrypting');
      setCurrentStatus({ done: false, action: 'encrypting', description: 'Encrypting message for TEE…', timestamp: Date.now() });

      try {
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
            },
          },
          {
            body: {
              model,
              toolsEnabled: webSearchEnabled,
              includeImages: selectedModelAcceptsImages,
            },
          },
        );
      } catch (err: any) {
        setCurrentStatus({ done: true, action: 'error', description: err?.message || 'Unexpected error', timestamp: Date.now(), level: 'error' });
      }
    },
    [input, attachments, aiStatus, sendAiMessage, model, webSearchEnabled, selectedModelAcceptsImages],
  );

  /* ── Phase 3: Nudge computation ──────────────────────────────────────────── */
  const computeNudges = useCallback(() => {
    const store = memoryStoreRef.current;
    const newNudges: NudgeAction[] = [];
    const nudgeId = (type: string) => `${type}-${Date.now()}`;

    if (store.shouldNudgeMemory(MEMORY_NUDGE_INTERVAL) && !store.isDismissed('memory-nudge')) {
      newNudges.push({
        id: nudgeId('memory'),
        type: 'save_memory',
        label: "I've learned some things about you",
        description: 'Save what I remember to personalize future conversations.',
        suggestions: ['Save preferences', "Don't ask again"],
      });
    }

    if (store.shouldNudgeSkill(SKILL_NUDGE_INTERVAL) && !store.isDismissed('skill-nudge')) {
      newNudges.push({
        id: nudgeId('skill'),
        type: 'create_skill',
        label: 'Turn this workflow into a reusable skill',
        description: 'If this was a multi-step task, I can package it so you can reuse it with one command.',
        suggestions: ['Create skill', 'Not now'],
      });
    }

    setNudges(newNudges);
  }, []);

  useEffect(() => {
    if (aiStatus === 'ready' && aiMessages.length > 0) {
      computeNudges();
    }
  }, [aiStatus, aiMessages.length, computeNudges]);

  const handleNudgeAction = useCallback(
    (nudge: NudgeAction, choice: string) => {
      const store = memoryStoreRef.current;
      if (nudge.type === 'save_memory' && choice.includes('Save')) {
        // Heuristic: extract simple preferences from recent conversation
        const userMessages = messages.filter((m) => m.role === 'user');
        const recentContent = userMessages.slice(-3).map((m) => m.content).join(' ');
        if (recentContent.includes('prefer') || recentContent.includes('like') || recentContent.includes('always')) {
          store.addPreference('Prefers detailed, step-by-step responses');
        }
        store.addMemory('User prefers detailed explanations with examples', 'memory');
        store.resetMemoryNudge();
      }
      if (nudge.type === 'create_skill' && choice.includes('Create')) {
        // Heuristic placeholder — real skill would require the agent to construct the prompt
        store.addSkill(
          'General Q&A',
          'Standard chat with E2EE through Chutes TEE',
          'Answer the user question using the TEE-encrypted chat pipeline. Be thorough, cite sources when relevant, and respect user preferences from memory.',
        );
        store.resetSkillNudge();
      }
      // Dismiss after action
      setNudges((prev) => prev.filter((n) => n.id !== nudge.id));
    },
    [messages],
  );

  const handleNudgeDismiss = useCallback((id: string) => {
    setNudges((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const handleCloseMemory = useCallback((id: string) => {
    setMessages((prev) =>
      prev.map((m) => {
        if (!m.memoryContext) return m;
        return { ...m, memoryContext: m.memoryContext.filter((mc) => mc.id !== id) };
      }),
    );
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const nextAttachments = await Promise.all(
      Array.from(files).map(async (file): Promise<MessageAttachment> => {
        const base = {
          id: crypto.randomUUID(),
          name: file.name,
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
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  /* ── Interrupt-and-redirect (Phase 2) ────────────────────────────────────── */
  const abort = useCallback(() => {
    stopAiMessage();
    setIsLoading(false);
    setStreamStage('idle');
    setCurrentStatus(undefined);
  }, [stopAiMessage]);

  /* ── Retry / Regenerate helpers ─────────────────────────────────────────── */
  const retryLastMessage = useCallback(() => {
    retryCountRef.current += 1;
    if (retryCountRef.current > MAX_RETRIES) {
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1
            ? {
                role: 'assistant',
                content: 'Unable to get a response after multiple attempts.\\n\\nPlease check your API key or try again later.',
                isError: true,
              }
            : m,
        ),
      );
      return;
    }
    regenerateAiMessage({
      body: {
        model,
        toolsEnabled: webSearchEnabled,
        includeImages: selectedModelAcceptsImages,
      },
    });
  }, [regenerateAiMessage, model, webSearchEnabled, selectedModelAcceptsImages]);

  const regenerateMessage = useCallback(
    (assistantIdx: number) => {
      const messageId = messages[assistantIdx]?.id;
      retryCountRef.current = 0;
      regenerateAiMessage({
        messageId,
        body: {
          model,
          toolsEnabled: webSearchEnabled,
          includeImages: selectedModelAcceptsImages,
        },
      });
    },
    [messages, regenerateAiMessage, model, webSearchEnabled, selectedModelAcceptsImages],
  );

  /* ── Settings ───────────────────────────────────────────────────────────── */
  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setApiKeyError('');
    const res = await window.chutes.saveApiKey('chutes', apiKey.trim());
    if (res.ok) {
      applyApiKeyStatus(res);
      setShowSettings(false);
      setApiKey('');
    } else {
      setApiKeyError(res.error || 'Could not save API key.');
    }
  };

  const deleteKey = async () => {
    setApiKeyError('');
    const res = await window.chutes.deleteApiKey('chutes');
    if (res.ok) {
      applyApiKeyStatus(res);
      setApiKey('');
    } else {
      setApiKeyError(res.error || 'Could not delete API key.');
    }
  };

  /* ── Keyboard handling ──────────────────────────────────────────────────── */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  /* ── Render helpers ─────────────────────────────────────────────────────── */
  const stageIndicator = () => {
    if (!isLoading || streamStage === 'idle') return null;
    const stages: { key: StreamStage; label: string; icon: React.ReactNode }[] = [
      { key: 'encrypting', label: 'Encrypting…', icon: <Lock className="w-3 h-3" /> },
      { key: 'connecting', label: 'Connecting to TEE…', icon: <Fingerprint className="w-3 h-3" /> },
      { key: 'thinking', label: 'Thinking…', icon: <Zap className="w-3 h-3" /> },
      { key: 'streaming', label: isLoading ? 'Streaming…' : '', icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    ];
    const currentIdx = stages.findIndex((s) => s.key === streamStage);

    return (
      <div className="flex items-center gap-3 px-4 py-2 text-xs text-[var(--text-secondary)] animate-in fade-in">
        {stages.map((s, i) => {
          const done = i < currentIdx;
          const active = i === currentIdx;
          return (
            <div key={s.key} className={`flex items-center gap-1 transition-opacity ${active ? 'text-[var(--accent)]' : done ? 'opacity-40' : 'opacity-20'}`}>
              {done ? <Check className="w-3 h-3" /> : s.icon}
              <span>{s.label}</span>
              {i < stages.length - 1 && <span className="ml-1 opacity-30">→</span>}
            </div>
          );
        })}
      </div>
    );
  };

  const selectedModelStats = modelStats[model];
  const modelInputValue = showModelMenu ? modelQuery : model;
  const modelInputWidth = `${Math.max(modelInputValue.length + 1, 18)}ch`;

  return (
    <div className="flex flex-col h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-[var(--accent)]" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            Chutes E2EE Chat
          </h1>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {/* Model picker */}
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
              <Sparkles className="w-3.5 h-3.5" />
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
                placeholder="Search models"
                spellCheck={false}
              />
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
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
            {showModelMenu && (
              <div id="model-options" role="listbox" className="absolute right-0 top-full mt-1 w-[min(980px,calc(100vw-2rem))] rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] shadow-xl z-50 max-h-80 overflow-auto">
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
                          className={`grid min-w-[760px] w-full grid-cols-[minmax(22rem,1fr)_7rem_6rem_6rem_7rem_1.5rem] items-center gap-4 px-3 py-2 text-left text-sm transition-colors ${
                            active ? 'bg-[var(--bg-tertiary)]' : ''
                          } ${selected ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
                        >
                          <span className="whitespace-normal break-words">{m}</span>
                          <ModelStatsColumns stats={modelStats[m]} />
                          <span className="flex justify-end">
                            {selected && <Check className="w-3.5 h-3.5 shrink-0" />}
                          </span>
                        </button>
                      );
                    })}
                  </>
                ) : (
                  <div className="px-3 py-2 text-sm text-[var(--text-secondary)] opacity-70">
                    No matching models
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Memory status */}
          <button
            onClick={() => setShowMemoryPanel((v) => !v)}
            className="p-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors relative"
            title="View saved memories"
          >
            <Brain className="w-4 h-4" />
            {memoryStoreRef.current.getMemories().length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-[var(--accent)] rounded-full" />
            )}
          </button>

          {/* Settings */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors relative"
          >
            <Settings className="w-4 h-4" />
            {!apiKeySaved && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-500 rounded-full" />}
          </button>
        </div>
      </header>

      {/* API Key warning */}
      {!apiKeySaved && (
        <div className="px-6 py-2 bg-red-950/60 border-b border-red-900/50 text-xs text-red-300 flex items-center gap-2 justify-center">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>No API key configured.</span>
          <button onClick={() => setShowSettings(true)} className="underline hover:text-red-200">
            Open Settings to add your Chutes API key
          </button>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div ref={settingsRef} className="w-[420px] rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border)] p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Settings</h2>
              <button onClick={() => setShowSettings(false)} className="text-[var(--text-secondary)] hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)] mb-1.5">
                  <KeyRound className="w-3.5 h-3.5" />
                  Chutes API Key
                </label>
                <p className="text-xs text-[var(--text-secondary)] mb-2">
                  Stored encrypted on this machine and used only by the Electron main process. Get yours at{' '}
                  <a href="https://chutes.ai/app/api-keys" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
                    chutes.ai/app/api-keys
                  </a>
                </p>
                {apiKeyStatus.canPersist && apiKeyStatus.storageMode === 'localFileKey' && (
                  <p className="text-xs text-amber-300 mb-2">
                    Using local encrypted storage for this WSL/Linux environment. Keep your user profile files private.
                  </p>
                )}
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={apiKeySaved ? '••••••••••••••••' : 'cpk_...'}
                  className="w-full rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm px-3 py-2 outline-none focus:ring-1 focus:ring-[var(--accent)] border border-[var(--border)]"
                />
                <button onClick={saveKey} disabled={!apiKey.trim()} className="mt-2 w-full py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black text-sm font-medium transition-colors disabled:opacity-40">
                  {apiKeyStatus.hasStoredKey ? 'Update Stored API Key' : 'Save API Key'}
                </button>
                {apiKeyStatus.hasStoredKey && (
                  <button onClick={deleteKey} className="mt-2 w-full py-2 rounded-lg border border-red-900/60 text-red-300 hover:bg-red-950/40 text-sm font-medium transition-colors flex items-center justify-center gap-2">
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove Stored API Key
                  </button>
                )}
                {apiKeyError && (
                  <p className="text-xs text-red-300 mt-2">{apiKeyError}</p>
                )}
              </div>
              {apiKeySaved && (
                <p className="text-xs text-[var(--accent)] flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  {apiKeyStatus.isOsBackedStorage
                    ? 'API key stored with OS-backed encryption'
                    : 'API key stored with local encrypted storage'}
                </p>
              )}

              {/* Memory tools */}
              <div className="border-t border-[var(--border)] pt-4">
                <h3 className="text-sm font-medium text-[var(--text-primary)] mb-2">Saved Memory</h3>
                <div className="flex flex-col gap-2">
                  {memoryStoreRef.current.getMemories().length === 0 ? (
                    <p className="text-xs text-[var(--text-secondary)]">No memories saved yet.</p>
                  ) : (
                    memoryStoreRef.current.getMemories().map((mem) => (
                      <div key={mem.id} className="flex items-start justify-between gap-2 text-xs bg-[var(--bg-tertiary)] rounded-lg px-3 py-2">
                        <span className="text-[var(--text-secondary)]">{mem.content}</span>
                        <button
                          onClick={() => {
                            memoryStoreRef.current.removeMemory(mem.id);
                            setMessages((prev) => [...prev]); // force re-render
                          }}
                          className="shrink-0 text-red-400 hover:text-red-300"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Memory viewer panel */}
      {showMemoryPanel && (
        <div className="fixed inset-0 z-50 flex items-start justify-end pt-20 pr-4 pointer-events-none">
          <MemoryPanel
            store={memoryStoreRef.current}
            onClose={() => setShowMemoryPanel(false)}
            onStateChange={() => setMessages((prev) => [...prev])}
          />
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.map((msg, i) =>
          msg.role === 'user' ? (
            <UserBubble key={i} content={msg.content} attachments={msg.attachments} />
          ) : (
            <AssistantBubble
              key={i}
              msg={msg}
              canRegenerate={
                !msg.isStreaming &&
                i > 0 &&
                messages.slice(0, i).some((m) => m.role === 'user')
              }
              onRegenerate={() => regenerateMessage(i)}
              onRetry={msg.isError || msg.isEmpty ? retryLastMessage : undefined}
            />
          ),
        )}

        {/* Phase 3: Memory nudges */}
        <MemoryNudge nudges={nudges} onAction={handleNudgeAction} onDismiss={handleNudgeDismiss} />

        {/* Phase 2: Live status card during work */}
        {currentStatus && isLoading && (
          <LiveStatusCard status={currentStatus} />
        )}

        {/* Stage indicator bar */}
        {stageIndicator()}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="max-w-4xl mx-auto">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-1 text-xs text-[var(--text-secondary)]">
                  {attachment.kind === 'image' ? <ImageIcon className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
                  <span>{attachment.name}</span>
                  {attachment.kind === 'unsupported' && <span className="text-amber-300">metadata only</span>}
                  <button onClick={() => removeAttachment(attachment.id)} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {attachments.some((attachment) => attachment.kind === 'image') && !selectedModelAcceptsImages && (
                <span className="text-xs text-amber-300 self-center">Selected model does not advertise image input.</span>
              )}
            </div>
          )}
          <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept="image/*,.txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.cpp,.h,.css,.html,.pdf"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-3 rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0"
            title="Attach files"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <button
            onClick={() => setWebSearchEnabled((enabled) => !enabled)}
            className={`p-3 rounded-xl transition-colors shrink-0 ${
              webSearchEnabled
                ? 'bg-[var(--accent)] text-black'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
            title="Use web search"
          >
            <Search className="w-4 h-4" />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isLoading ? 'Interrupt to send a new message…' : 'Type an encrypted message…'}
            rows={1}
            className="flex-1 resize-none rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-primary)] placeholder-[var(--text-secondary)] text-sm px-4 py-3 outline-none focus:ring-1 focus:ring-[var(--accent)] max-h-32"
            style={{ minHeight: '44px' }}
          />
          {isLoading ? (
            <button
              onClick={abort}
              className="p-3 rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors shrink-0"
              title="Interrupt current request"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() && attachments.length === 0}
              className="p-3 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black transition-colors disabled:opacity-40 shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
          </div>
        </div>
        <p className="text-center text-[10px] text-[var(--text-secondary)] mt-2">
          {isLoading
            ? 'Working… click stop to interrupt and redirect'
            : webSearchEnabled
            ? 'Web search enabled · ML-KEM-768 · ChaCha20-Poly1305 · HKDF-SHA256 — End-to-end encrypted via Chutes.ai TEE'
            : 'ML-KEM-768 · ChaCha20-Poly1305 · HKDF-SHA256 — End-to-end encrypted via Chutes.ai TEE'}
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Sub-components                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

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

function uiMessageToDisplayMessage(
  message: ChutesUIMessage,
  {
    isLast,
    status,
    error,
  }: {
    isLast: boolean;
    status: string;
    error?: Error;
  },
): Message {
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
  const reasoning = message.parts
    .filter((part) => part.type === 'reasoning')
    .map((part) => part.text)
    .join('');
  const toolStatuses = message.parts
    .filter((part) => part.type === 'dynamic-tool' || part.type.startsWith('tool-'))
    .map((part: any): MessageStatus => ({
      done: part.state === 'output-available' || part.state === 'output-error' || part.state === 'output-denied',
      action: part.state?.startsWith('output') ? 'tool_result' : 'tool_call',
      description:
        part.state === 'output-error'
          ? `${toolDisplayName(part)} failed: ${part.errorText || 'Unknown error'}`
          : part.state?.startsWith('output')
          ? `${toolDisplayName(part)} returned a result`
          : `Calling ${toolDisplayName(part)}…`,
      timestamp: Date.now(),
      level: part.state === 'output-error' ? 'error' : part.state?.startsWith('output') ? 'success' : 'info',
    }));

  const isLoading = isLast && (status === 'submitted' || status === 'streaming');
  const isError = isLast && status === 'error' && message.role === 'assistant';

  return {
    id: message.id,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: isError && !text ? (error?.message || 'Something went wrong.') : text,
    reasoning: reasoning || undefined,
    attachments: message.metadata?.attachments,
    memoryContext: message.metadata?.memoryContext,
    statusHistory: toolStatuses.length > 0 ? toolStatuses : undefined,
    isStreaming: message.role === 'assistant' && isLoading,
    isError,
    done: message.role === 'assistant' ? !isLoading : undefined,
  };
}

function toolDisplayName(part: any) {
  return String(part.type === 'dynamic-tool' ? part.toolName : part.type.replace(/^tool-/, ''));
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

function UserBubble({ content, attachments = [] }: { content: string; attachments?: MessageAttachment[] }) {
  return (
    <div className="flex gap-3 justify-end">
      <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed bg-[var(--user-bubble)] text-white rounded-br-md">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="inline-flex items-center gap-1 rounded-md bg-black/20 px-2 py-0.5 text-xs">
                {attachment.kind === 'image' ? <ImageIcon className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                {attachment.name}
              </span>
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap">{content}</div>
      </div>
      <div className="w-7 h-7 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0 mt-1">
        <User className="w-4 h-4 text-[var(--text-secondary)]" />
      </div>
    </div>
  );
}

function AssistantBubble({
  msg,
  canRegenerate,
  onRegenerate,
  onRetry,
}: {
  msg: Message;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [showReasoning, setShowReasoning] = useState(true);
  const [showStreamingReasoning, setShowStreamingReasoning] = useState(true);
  const streamingReasoningRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = streamingReasoningRef.current;
    if (!el || !msg.isStreaming || !showStreamingReasoning) return;
    el.scrollTop = el.scrollHeight;
  }, [msg.reasoning, msg.isStreaming, showStreamingReasoning]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const showMainContent = Boolean(msg.content) || Boolean(msg.isError) || Boolean(msg.isEmpty) || !msg.reasoning;

  return (
    <div className="flex gap-3 justify-start group">
      <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center shrink-0 mt-1">
        <Bot className="w-4 h-4 text-black" />
      </div>

      <div className="max-w-[80%] min-w-[120px]">
        {/* Phase 3: Memory recall fencing */}
        {msg.memoryContext && msg.memoryContext.length > 0 && (
          <MemoryRecallFencing
            memories={msg.memoryContext.map((mc) => ({ label: mc.label, content: mc.content }))}
            onClose={(id) => {
              /* noop for single-close — handled per-msg in page state */
            }}
          />
        )}

        {/* Phase 2: Status timeline */}
        {msg.statusHistory && msg.statusHistory.length > 0 && (
          <StatusTimeline history={msg.statusHistory} compact={!msg.done} />
        )}

        {/* Recovered badge */}
        {msg.recoveredFromError && (
          <div className="flex items-center gap-1.5 mb-1 text-[10px] text-emerald-400/80 animate-in fade-in">
            <Check className="w-3 h-3" />
            <span>Recovered automatically after error</span>
            {msg.modelUsed && msg.modelUsed !== DEFAULT_MODEL && (
              <span className="text-[var(--text-secondary)] opacity-60">(used {msg.modelUsed})</span>
            )}
          </div>
        )}

        {/* Reasoning toggle */}
        {msg.reasoning && !msg.isStreaming && (
          <button
            onClick={() => setShowReasoning((s) => !s)}
            className="flex items-center gap-1 mb-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
          >
            {showReasoning ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showReasoning ? 'Hide reasoning' : 'Show reasoning'}
            <span className="text-[var(--text-secondary)] opacity-50 ml-1">{msg.reasoning.length.toLocaleString()} chars</span>
          </button>
        )}

        {/* Reasoning content */}
        {showReasoning && msg.reasoning && !msg.isStreaming && (
          <div className="mb-2 text-xs text-[var(--text-secondary)] italic border-l-2 border-[var(--accent)]/50 pl-2.5 py-1 animate-in fade-in whitespace-pre-wrap">
            {msg.reasoning}
          </div>
        )}

        {/* Streaming reasoning */}
        {msg.reasoning && msg.isStreaming && (
          <div className="mb-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/80 animate-in fade-in overflow-hidden">
            <button
              type="button"
              onClick={() => setShowStreamingReasoning((s) => !s)}
              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Brain className="w-3 h-3" />
                Thinking
                <span className="opacity-50">{msg.reasoning.length.toLocaleString()} chars</span>
              </span>
              {showStreamingReasoning ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {showStreamingReasoning && (
              <div ref={streamingReasoningRef} className="max-h-[40vh] overflow-y-auto border-t border-[var(--border)] px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)] italic whitespace-pre-wrap">
                {msg.reasoning}
              </div>
            )}
          </div>
        )}

        {/* Main content */}
        {showMainContent && (
          <div
            className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-[var(--assistant-bubble)] text-[var(--text-primary)] rounded-bl-md ${
              msg.isError ? 'border border-red-900/60 bg-red-950/30' : ''
            } ${msg.isEmpty ? 'border border-yellow-900/40 bg-yellow-950/20' : ''}`}
          >
            {msg.content || msg.isStreaming ? (
              msg.content
            ) : msg.isEmpty ? (
              <EmptyMessage onRetry={onRetry} />
            ) : msg.isError ? (
              <ErrorMessage content={msg.content} onRetry={onRetry} />
            ) : (
              <span className="italic opacity-40">No response</span>
            )}

            {msg.isStreaming && !msg.content && !msg.reasoning && (
              <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
            )}
          </div>
        )}

        {/* Actions toolbar */}
        {!msg.isStreaming && msg.content && (
          <div className="flex items-center gap-2 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={copy} className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" title="Copy to clipboard">
              {copied ? <Check className="w-3 h-3 text-[var(--accent)]" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {canRegenerate && (
              <button onClick={onRegenerate} className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" title="Regenerate response">
                <RotateCcw className="w-3 h-3" />
                Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyMessage({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2 text-yellow-400/80">
        <AlertTriangle className="w-4 h-4" />
        <span>The model returned an empty response.</span>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors">
          <RotateCcw className="w-3.5 h-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}

function ErrorMessage({
  content,
  onRetry,
}: {
  content: string;
  onRetry?: () => void;
}) {
  const isNetwork = content.includes('Network') || content.includes('connect');
  const isAuth = content.includes('Authentication') || content.includes('401') || content.includes('403');

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2 text-red-400/90">
        {isNetwork ? <WifiOff className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
        <span>{isAuth ? 'Authentication failed — check your API key in Settings.' : content.split('\n')[0]}</span>
      </div>
      {onRetry && !isAuth && (
        <button onClick={onRetry} className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors">
          <RotateCcw className="w-3.5 h-3.5" />
          Retry
        </button>
      )}
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
    <div className="pointer-events-auto w-80 max-h-[70vh] overflow-y-auto rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border)] shadow-2xl p-4 flex flex-col gap-3 animate-in fade-in">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Brain className="w-4 h-4 text-[var(--accent)]" />
          Saved Memories
        </h3>
        <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-[var(--text-secondary)] transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex gap-2">
        <input
          value={newMemory}
          onChange={(e) => setNewMemory(e.target.value)}
          placeholder="Add a memory…"
          className="flex-1 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-xs px-3 py-2 outline-none focus:ring-1 focus:ring-[var(--accent)] border border-[var(--border)]"
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
          className="p-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
        </button>
      </div>

      {memories.length === 0 ? (
        <div className="text-xs text-[var(--text-secondary)] text-center py-4">
          No memories yet. They accumulate as we chat, or add one above.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {memories.map((mem, i) => (
            <div key={mem.id} className="flex items-start gap-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 group">
              <span className="text-[10px] text-[var(--text-secondary)] mt-0.5 shrink-0 w-4">{i + 1}.</span>
              <span className="flex-1 text-xs text-[var(--text-secondary)] leading-relaxed">{mem.content}</span>
              <button
                onClick={() => {
                  store.removeMemory(mem.id);
                  refresh();
                }}
                className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-950/40 text-red-400 transition-all"
                title="Delete memory"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-[var(--border)] pt-3">
        <h4 className="text-[11px] font-medium text-[var(--text-secondary)] mb-2 uppercase tracking-wider">Skills</h4>
        {store.getSkills().length === 0 ? (
          <p className="text-[11px] text-[var(--text-secondary)] opacity-60">No skills created yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {store.getSkills().map((skill) => (
              <div key={skill.id} className="text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] rounded-lg px-3 py-1.5">
                <span className="font-medium text-[var(--text-primary)]">{skill.name}</span>
                <span className="text-[10px] text-[var(--text-secondary)] opacity-60 ml-2">({skill.useCount} uses)</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

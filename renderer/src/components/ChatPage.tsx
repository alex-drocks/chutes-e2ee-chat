'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
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
} from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  isStreaming?: boolean;
  isError?: boolean;
  isEmpty?: boolean;
}

const DEFAULT_MODEL = 'Qwen/Qwen3-32B-TEE';
const FALLBACK_MODELS = [
  'Qwen/Qwen3-32B-TEE',
  'moonshotai/Kimi-K2.6-TEE',
  'moonshotai/Kimi-K2.5-TEE',
  'deepseek-ai/DeepSeek-V3-TEE',
  'deepseek-ai/DeepSeek-R1-TEE',
];

const MAX_RETRIES = 2;

type StreamStage = 'idle' | 'encrypting' | 'connecting' | 'thinking' | 'streaming';

/* ─────────────────────────────────────────────────────────────────────────── */

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        'Welcome to Chutes E2EE Chat. Your messages are encrypted end-to-end using ML-KEM-768 + ChaCha20-Poly1305. Only the TEE GPU instance can decrypt your prompts.',
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [streamStage, setStreamStage] = useState<StreamStage>('idle');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef<string | null>(null);

  // Track whether this request has produced any content / reasoning
  const hasContentRef = useRef(false);
  const retryCountRef = useRef(0);

  /* ── Fetch available models ─────────────────────────────────────────────── */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;
    window.chutes.models().then((res: any) => {
      if (res.ok && res.models && res.models.length > 0) {
        setModels(res.models.filter((m: string) => m.includes('TEE')));
      }
    });
  }, []);

  /* ── Load stored API key ────────────────────────────────────────────────── */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;
    window.chutes.getApiKey('chutes').then((res: any) => {
      if (res.ok && res.apiKey) setApiKeySaved(true);
    });
  }, []);

  /* ── Auto-scroll ────────────────────────────────────────────────────────── */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ── Close menus on outside click ───────────────────────────────────────── */
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setShowModelMenu(false);
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node))
        setShowSettings(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  /* ── Auto-resize textarea ───────────────────────────────────────────────── */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

  /* ── Register stream listeners ──────────────────────────────────────────── */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;

    const disposeChunk = window.chutes.onStreamChunk((payload: any) => {
      if (requestIdRef.current && payload.requestId !== requestIdRef.current)
        return;

      if (payload.done) {
        setIsLoading(false);
        setStreamStage('idle');

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const isEmpty = last?.role === 'assistant' && !last.content && !last.reasoning;
          const next = prev.map((m, i) =>
            i === prev.length - 1
              ? {
                  ...m,
                  isStreaming: false,
                  isEmpty:
                    isEmpty && !hasContentRef.current ? true : m.isEmpty,
                }
              : m,
          );
          return next;
        });

        setRequestId(null);
        requestIdRef.current = null;
        retryCountRef.current = 0;
        return;
      }

      if (!payload.data) return;

      try {
        const parsed = JSON.parse(payload.data);
        const delta = parsed.choices?.[0]?.delta;

        if (delta) {
          const content = delta.content || '';
          const reasoning = delta.reasoning_content || '';

          if (content || reasoning) {
            hasContentRef.current = true;
          }

          // Stage transitions based on what data we see
          if (reasoning && !content) {
            setStreamStage('thinking');
          } else if (content) {
            setStreamStage('streaming');
          }

          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last.role !== 'assistant' || !last.isStreaming) return prev;
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                content: last.content + content,
                reasoning: last.reasoning
                  ? last.reasoning + reasoning
                  : reasoning || undefined,
              },
            ];
          });
        }
      } catch {
        // non-JSON chunk
        hasContentRef.current = true;
        setStreamStage('streaming');
      }
    });

    const disposeError = window.chutes.onStreamError((payload: any) => {
      if (requestIdRef.current && payload.requestId !== requestIdRef.current)
        return;

      setIsLoading(false);
      setStreamStage('idle');
      hasContentRef.current = false;

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.isStreaming) {
          // Replace the empty streaming bubble with the error
          return [
            ...prev.slice(0, -1),
            {
              role: 'assistant',
              content: friendlyErrorMessage(payload.error),
              isError: true,
            },
          ];
        }
        return [
          ...prev,
          {
            role: 'assistant',
            content: friendlyErrorMessage(payload.error),
            isError: true,
          },
        ];
      });

      setRequestId(null);
      requestIdRef.current = null;
      retryCountRef.current = 0;
    });

    return () => {
      disposeChunk();
      disposeError();
    };
  }, []);

  /* ── Send message ───────────────────────────────────────────────────────── */
  const sendMessage = useCallback(
    async (opts?: { retry?: boolean; overrideInput?: string }) => {
      const text = (opts?.overrideInput ?? input).trim();
      if (!text || requestIdRef.current !== null) return;

      if (!opts?.retry) {
        setInput('');
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: text },
          { role: 'assistant', content: '', isStreaming: true },
        ]);
      } else {
        // Regenerate: replace last assistant with fresh streaming bubble
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.role === 'assistant'
              ? { role: 'assistant', content: '', isStreaming: true, reasoning: undefined }
              : m,
          ),
        );
      }

      setIsLoading(true);
      hasContentRef.current = false;
      setStreamStage('encrypting');

      const id = crypto.randomUUID();
      setRequestId(id);
      requestIdRef.current = id;

      const history = messages
        .filter((m) => !m.isStreaming && !m.isError && !m.isEmpty)
        .map((m) => ({ role: m.role, content: m.content }));

      const params = {
        model,
        messages: [...history, { role: 'user', content: text }],
        stream: true,
        max_tokens: 2048,
      };

      try {
        setStreamStage('connecting');
        const res = await window.chutes.chat(id, params);
        if (!res.ok) {
          handleSendFailure(res.error || 'Request failed.\n\nThe server may be temporarily unavailable. Please try again.');
        }
      } catch (err: any) {
        handleSendFailure(err?.message || 'Unexpected error.');
      }
    },
    [input, messages, model],
  );

  function handleSendFailure(errorMessage: string) {
    setIsLoading(false);
    setStreamStage('idle');
    hasContentRef.current = false;
    setRequestId(null);
    requestIdRef.current = null;

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.isStreaming) {
        return [
          ...prev.slice(0, -1),
          { role: 'assistant', content: friendlyErrorMessage(errorMessage), isError: true },
        ];
      }
      return prev;
    });
  }

  const abort = useCallback(() => {
    if (requestIdRef.current) {
      window.chutes.abort(requestIdRef.current);
      setIsLoading(false);
      setStreamStage('idle');
      hasContentRef.current = false;
      setRequestId(null);
      requestIdRef.current = null;
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1 && m.isStreaming
            ? { ...m, isStreaming: false }
            : m,
        ),
      );
    }
  }, []);

  /* ── Retry / Regenerate helpers ─────────────────────────────────────────── */

  /** Retry a failed or empty assistant message. User message is already in history. */
  const retryLastMessage = useCallback(() => {
    // Find the user message that corresponds to the last assistant message
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === 'user');
    if (!lastUserMsg) return;

    retryCountRef.current += 1;
    if (retryCountRef.current > MAX_RETRIES) {
      // Too many retries — show a permanent error
      setMessages((prev) =>
        prev.map((m, i) =>
          i === prev.length - 1
            ? {
                role: 'assistant',
                content:
                  'Unable to get a response after multiple attempts.\n\nPlease check your API key or try again later.',
                isError: true,
              }
            : m,
        ),
      );
      return;
    }

    sendMessage({ retry: true, overrideInput: lastUserMsg.content });
  }, [messages, sendMessage]);

  /** Regenerate a specific assistant message at index `assistantIdx`. */
  const regenerateMessage = useCallback(
    (assistantIdx: number) => {
      // Find the user message that preceded this assistant message
      let userIdx = -1;
      for (let i = assistantIdx - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          userIdx = i;
          break;
        }
      }
      if (userIdx === -1) return;

      // Trim messages to before this assistant message (removing it + any messages after)
      const trimmed = messages.slice(0, assistantIdx);
      setMessages([
        ...trimmed,
        { role: 'assistant', content: '', isStreaming: true },
      ]);

      const userText = messages[userIdx].content;
      retryCountRef.current = 0;

      // Delay to let state settle
      setTimeout(() => {
        sendMessage({ retry: true, overrideInput: userText });
      }, 0);
    },
    [messages, sendMessage],
  );

  /* ── Settings ───────────────────────────────────────────────────────────── */
  const saveKey = async () => {
    if (!apiKey.trim()) return;
    const res = await window.chutes.saveApiKey('chutes', apiKey.trim());
    if (res.ok) {
      setApiKeySaved(true);
      setShowSettings(false);
      setApiKey('');
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
              {i < stages.length - 1 && (
                <span className="ml-1 opacity-30">→</span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-[var(--accent)]" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">
            Chutes E2EE Chat
          </h1>
        </div>

        <div className="flex items-center gap-2">
          {/* Model picker */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowModelMenu(!showModelMenu)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span className="max-w-[200px] truncate">{model}</span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
            {showModelMenu && (
              <div className="absolute right-0 top-full mt-1 w-72 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] shadow-xl z-50 py-1 max-h-64 overflow-auto">
                {models.map((m) => (
                  <button
                    key={m}
                    onClick={() => { setModel(m); setShowModelMenu(false); }}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] transition-colors truncate ${
                      m === model ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Settings */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors relative"
          >
            <Settings className="w-4 h-4" />
            {!apiKeySaved && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-500 rounded-full" />
            )}
          </button>
        </div>
      </header>

      {/* API Key warning */}
      {!apiKeySaved && (
        <div className="px-6 py-2 bg-red-950/60 border-b border-red-900/50 text-xs text-red-300 flex items-center gap-2 justify-center">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>No API key configured.</span>
          <button
            onClick={() => setShowSettings(true)}
            className="underline hover:text-red-200"
          >
            Open Settings to add your Chutes API key
          </button>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div
            ref={settingsRef}
            className="w-[420px] rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border)] p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                Settings
              </h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-[var(--text-secondary)] hover:text-white"
              >
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
                  Stored encrypted at rest. Get yours at{' '}
                  <a
                    href="https://chutes.ai/app/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--accent)] hover:underline"
                  >
                    chutes.ai/app/api-keys
                  </a>
                </p>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={apiKeySaved ? '••••••••••••••••' : 'cpk_...'}
                  className="w-full rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm px-3 py-2 outline-none focus:ring-1 focus:ring-[var(--accent)] border border-[var(--border)]"
                />
                <button
                  onClick={saveKey}
                  disabled={!apiKey.trim()}
                  className="mt-2 w-full py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black text-sm font-medium transition-colors disabled:opacity-40"
                >
                  {apiKeySaved ? 'Update API Key' : 'Save API Key'}
                </button>
              </div>

              {apiKeySaved && (
                <p className="text-xs text-[var(--accent)] flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  API key stored securely
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.map((msg, i) =>
          msg.role === 'user' ? (
            <UserBubble key={i} content={msg.content} />
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
              onRetry={
                msg.isError || msg.isEmpty ? retryLastMessage : undefined
              }
            />
          ),
        )}

        {/* Stage indicator bar */}
        {stageIndicator()}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-end gap-2 max-w-4xl mx-auto">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type an encrypted message…"
            rows={1}
            className="flex-1 resize-none rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-primary)] placeholder-[var(--text-secondary)] text-sm px-4 py-3 outline-none focus:ring-1 focus:ring-[var(--accent)] max-h-32"
            style={{ minHeight: '44px' }}
          />
          {isLoading ? (
            <button
              onClick={abort}
              className="p-3 rounded-xl bg-red-600 hover:bg-red-700 text-white transition-colors shrink-0"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim()}
              className="p-3 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black transition-colors disabled:opacity-40 shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
        <p className="text-center text-[10px] text-[var(--text-secondary)] mt-2">
          ML-KEM-768 · ChaCha20-Poly1305 · HKDF-SHA256 — End-to-end encrypted
          via Chutes.ai TEE
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Sub-components                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex gap-3 justify-end">
      <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap bg-[var(--user-bubble)] text-white rounded-br-md">
        {content}
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
  const [showReasoning, setShowReasoning] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const isEmptyOrError = msg.isError || msg.isEmpty;

  return (
    <div className="flex gap-3 justify-start group">
      <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center shrink-0 mt-1">
        <Bot className="w-4 h-4 text-black" />
      </div>

      <div className="max-w-[80%] min-w-[120px]">
        {/* Reasoning toggle */}
        {msg.reasoning && !msg.isStreaming && (
          <button
            onClick={() => setShowReasoning((s) => !s)}
            className="flex items-center gap-1 mb-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
          >
            {showReasoning ? (
              <ChevronUp className="w-3 h-3" />
            ) : (
              <ChevronDown className="w-3 h-3" />
            )}
            {showReasoning ? 'Hide reasoning' : 'Show reasoning'}
            <span className="text-[var(--text-secondary)] opacity-50 ml-1">
              {msg.reasoning.length.toLocaleString()} chars
            </span>
          </button>
        )}

        {/* Reasoning content */}
        {showReasoning && msg.reasoning && (
          <div className="mb-2 text-xs text-[var(--text-secondary)] italic border-l-2 border-[var(--accent)]/50 pl-2.5 py-1 animate-in fade-in">
            {msg.reasoning}
          </div>
        )}

        {/* Streaming reasoning peek */}
        {msg.reasoning && msg.isStreaming && (
          <div className="mb-2 text-xs text-[var(--text-secondary)] italic border-l-2 border-[var(--accent)] pl-2.5 py-1">
            {msg.reasoning.length > 120
              ? msg.reasoning.slice(0, 120) + '…'
              : msg.reasoning}
          </div>
        )}

        {/* Main content */}
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

        {/* Actions toolbar */}
        {!msg.isStreaming && msg.content && (
          <div className="flex items-center gap-2 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={copy}
              className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title="Copy to clipboard"
            >
              {copied ? (
                <Check className="w-3 h-3 text-[var(--accent)]" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
            {canRegenerate && (
              <button
                onClick={onRegenerate}
                className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                title="Regenerate response"
              >
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
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
        >
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
  const isNetwork = content.includes('Network') || content.includes('abort');
  const isAuth = content.includes('Authentication') || content.includes('401') || content.includes('403');

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2 text-red-400/90">
        {isNetwork ? (
          <WifiOff className="w-4 h-4" />
        ) : (
          <AlertTriangle className="w-4 h-4" />
        )}
        <span>
          {isAuth
            ? 'Authentication failed — check your API key in Settings.'
            : content.split('\n')[0]}
        </span>
      </div>
      {onRetry && !isAuth && (
        <button
          onClick={onRetry}
          className="flex items-center gap-1.5 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */

function friendlyErrorMessage(raw: string): string {
  if (!raw) return 'An unknown error occurred.';
  if (raw.includes('401') || raw.includes('403') || raw.includes('auth')) {
    return 'Authentication failed.\n\nYour API key may be invalid or expired. Check Settings to update it.';
  }
  if (raw.includes('429') || raw.includes('rate')) {
    return 'Rate limited.\n\nToo many requests — please wait a moment and try again.';
  }
  if (raw.includes('Network') || raw.includes('fetch') || raw.includes('abort')) {
    return 'Network error.\n\nCould not connect to Chutes TEE. Please check your internet connection and try again.';
  }
  return raw;
}

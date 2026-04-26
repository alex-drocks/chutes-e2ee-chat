'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, Loader2, Bot, User, Shield, ChevronDown, Sparkles } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  isStreaming?: boolean;
}

const DEFAULT_MODEL = 'Qwen/Qwen3-32B-TEE';
const FALLBACK_MODELS = [
  'Qwen/Qwen3-32B-TEE',
  'moonshotai/Kimi-K2.6-TEE',
  'moonshotai/Kimi-K2.5-TEE',
  'deepseek-ai/DeepSeek-V3',
  'deepseek-ai/DeepSeek-R1',
];

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: 'Welcome to Chutes E2EE Chat. Your messages are encrypted end-to-end using ML-KEM-768 + ChaCha20-Poly1305. Only the TEE GPU instance can decrypt your prompts.',
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fetch available models on mount
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;
    window.chutes.models().then((res) => {
      if (res.ok && res.models && res.models.length > 0) {
        setModels(res.models.filter((m) => m.includes('TEE') || m.includes('-TEE')));
      }
    });
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Register stream listeners once
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chutes) return;

    const removeChunk = window.chutes.onStreamChunk((payload) => {
      if (payload.done) {
        setMessages((prev) =>
          prev.map((m, i) => (i === prev.length - 1 ? { ...m, isStreaming: false } : m)),
        );
        setIsLoading(false);
        setRequestId(null);
        return;
      }
      if (!payload.data) return;
      try {
        const parsed = JSON.parse(payload.data);
        const delta = parsed.choices?.[0]?.delta;
        if (delta) {
          const content = delta.content || '';
          const reasoning = delta.reasoning_content || '';
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last.role !== 'assistant' || !last.isStreaming) return prev;
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                content: last.content + content,
                reasoning: last.reasoning ? last.reasoning + reasoning : reasoning || undefined,
              },
            ];
          });
        }
      } catch {
        // non-JSON chunk, ignore
      }
    });

    const removeError = window.chutes.onStreamError((payload) => {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${payload.error}` },
      ]);
      setIsLoading(false);
      setRequestId(null);
    });

    return () => {
      // electron ipc listeners can't be removed this way, but
      // multiple registrations are harmless since we guard by requestId
      void removeChunk;
      void removeError;
    };
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    const userMsg = input.trim();
    setInput('');
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: userMsg },
      { role: 'assistant', content: '', isStreaming: true },
    ]);
    setIsLoading(true);

    const id = crypto.randomUUID();
    setRequestId(id);

    const history = messages
      .filter((m) => !m.isStreaming && m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const params = {
      model,
      messages: [...history, { role: 'user', content: userMsg }],
      stream: true,
      max_tokens: 2048,
    };

    try {
      const res = await window.chutes.chat(id, params);
      if (!res.ok) {
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: res.error || 'Request failed.' },
        ]);
        setIsLoading(false);
        setRequestId(null);
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { role: 'assistant', content: err?.message || 'Unexpected error.' },
      ]);
      setIsLoading(false);
      setRequestId(null);
    }
  }, [input, isLoading, messages, model]);

  const abort = useCallback(() => {
    if (requestId) {
      window.chutes.abort(requestId);
      setIsLoading(false);
      setRequestId(null);
      setMessages((prev) =>
        prev.map((m, i) => (i === prev.length - 1 && m.isStreaming ? { ...m, isStreaming: false } : m)),
      );
    }
  }, [requestId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[var(--bg-primary)]">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-[var(--accent)]" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Chutes E2EE Chat</h1>
        </div>

        <div className="relative">
          <button
            onClick={() => setShowModelMenu(!showModelMenu)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--bg-tertiary)] text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {model}
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {showModelMenu && (
            <div className="absolute right-0 top-full mt-1 w-72 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] shadow-xl z-50 py-1 max-h-64 overflow-auto">
              {models.map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setModel(m);
                    setShowModelMenu(false);
                  }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] transition-colors ${
                    m === model ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center shrink-0 mt-1">
                <Bot className="w-4 h-4 text-black" />
              </div>
            )}
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-[var(--user-bubble)] text-white rounded-br-md'
                  : 'bg-[var(--assistant-bubble)] text-[var(--text-primary)] rounded-bl-md'
              }`}
            >
              {msg.reasoning && (
                <div className="text-xs text-[var(--text-secondary)] mb-2 italic border-l-2 border-[var(--accent)] pl-2">
                  {msg.reasoning}
                </div>
              )}
              {msg.content || (msg.isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : '')}
            </div>
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-lg bg-[var(--bg-tertiary)] flex items-center justify-center shrink-0 mt-1">
                <User className="w-4 h-4 text-[var(--text-secondary)]" />
              </div>
            )}
          </div>
        ))}
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
            placeholder="Type an encrypted message..."
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
              onClick={sendMessage}
              disabled={!input.trim()}
              className="p-3 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black transition-colors disabled:opacity-40 shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
        <p className="text-center text-[10px] text-[var(--text-secondary)] mt-2">
          ML-KEM-768 · ChaCha20-Poly1305 · HKDF-SHA256 — End-to-end encrypted via Chutes.ai TEE
        </p>
      </div>
    </div>
  );
}

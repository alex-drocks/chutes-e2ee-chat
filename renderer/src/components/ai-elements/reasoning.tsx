'use client';

import { Brain, ChevronDown, ChevronUp } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';

import { cn } from '@/lib/utils';

type ReasoningContextValue = {
  isOpen: boolean;
  isStreaming: boolean;
  setIsOpen: (value: boolean) => void;
  chars: number;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoningContext() {
  const value = useContext(ReasoningContext);
  if (!value) throw new Error('Reasoning components must be used inside Reasoning.');
  return value;
}

type ReasoningProps = HTMLAttributes<HTMLDivElement> & {
  isStreaming?: boolean;
  defaultOpen?: boolean;
  chars?: number;
};

export function Reasoning({
  isStreaming = false,
  defaultOpen,
  chars = 0,
  className,
  children,
  ...props
}: ReasoningProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? isStreaming);

  useEffect(() => {
    if (isStreaming) setIsOpen(true);
  }, [isStreaming]);

  const context = useMemo(
    () => ({ isOpen, isStreaming, setIsOpen, chars }),
    [chars, isOpen, isStreaming],
  );

  return (
    <ReasoningContext.Provider value={context}>
      <div
        className={cn(
          'mb-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/70',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </ReasoningContext.Provider>
  );
}

type ReasoningTriggerProps = HTMLAttributes<HTMLButtonElement> & {
  children?: ReactNode;
};

export function ReasoningTrigger({ className, children, ...props }: ReasoningTriggerProps) {
  const { isOpen, setIsOpen, isStreaming, chars } = useReasoningContext();

  return (
    <button
      type="button"
      onClick={() => setIsOpen(!isOpen)}
      className={cn(
        'flex w-full items-center justify-between gap-3 px-3 py-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]',
        className,
      )}
      {...props}
    >
      <span className="flex items-center gap-1.5">
        <Brain className="h-3 w-3" />
        {children ?? (isStreaming ? 'Thinking' : 'Reasoning')}
        {chars > 0 && <span className="opacity-50">{chars.toLocaleString()} chars</span>}
      </span>
      {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
    </button>
  );
}

type ReasoningContentProps = HTMLAttributes<HTMLDivElement>;

export function ReasoningContent({ className, style, children, onScroll, ...props }: ReasoningContentProps) {
  const { isOpen, isStreaming, chars } = useReasoningContext();
  const localRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const markdown = typeof children === 'string' ? children : null;

  useEffect(() => {
    if (!isOpen || !isAtBottom) return;
    const el = localRef.current;
    if (!el) return;

    const frame = window.requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [chars, isAtBottom, isOpen]);

  if (!isOpen) return null;

  return (
    <div
      ref={localRef}
      onScroll={(event) => {
        const el = event.currentTarget;
        setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        onScroll?.(event);
      }}
      className={cn(
        'overflow-y-auto border-t border-[var(--border)] px-3 py-2 text-xs leading-relaxed text-[var(--text-secondary)]',
        className,
      )}
      style={{
        maxHeight: isStreaming ? 'min(42vh, 380px)' : 'min(28vh, 260px)',
        ...style,
      }}
      {...props}
    >
      {markdown !== null ? (
        <Streamdown
          isAnimating={isStreaming}
          controls={{ code: false, table: true, mermaid: false }}
          shikiTheme={['github-light', 'github-dark-default']}
          className={cn(
            'max-w-none break-words text-xs leading-6 text-[var(--text-secondary)]',
            '[&_a]:text-[var(--accent)] [&_a]:underline [&_a]:underline-offset-2',
            '[&_p]:my-2 first:[&_p]:mt-0 last:[&_p]:mb-0',
            '[&_strong]:font-semibold [&_strong]:text-[var(--text-primary)]',
            '[&_em]:italic',
            '[&_blockquote]:border-l-2 [&_blockquote]:border-[var(--accent)]/35 [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)]',
            '[&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.92em] [&_code]:text-[var(--text-primary)]',
            '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border)] [&_pre]:bg-black/35 [&_pre]:p-3',
            '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
            '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
            '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
            '[&_li]:my-1 [&_li]:pl-1 [&_li>p]:my-1',
            '[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
            '[&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1',
            '[&_th]:border [&_th]:border-[var(--border)] [&_th]:bg-white/5 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
          )}
        >
          {markdown}
        </Streamdown>
      ) : (
        children
      )}
    </div>
  );
}

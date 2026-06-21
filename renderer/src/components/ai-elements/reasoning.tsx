'use client';

import { Brain, ChevronDown, ChevronUp } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

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

export function ReasoningContent({ className, ...props }: ReasoningContentProps) {
  const { isOpen } = useReasoningContext();
  if (!isOpen) return null;

  return (
    <div
      className={cn(
        'max-h-[42vh] overflow-y-auto border-t border-[var(--border)] px-3 py-2 text-xs italic leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap',
        className,
      )}
      {...props}
    />
  );
}

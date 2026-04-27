'use client';

import { Search, Zap } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/utils';

type ToolProps = HTMLAttributes<HTMLDivElement> & {
  state?: string;
  isError?: boolean;
};

export function Tool({ state, isError = false, className, ...props }: ToolProps) {
  const complete = state?.startsWith('output');
  return (
    <div
      className={cn(
        'mb-2 inline-flex max-w-full flex-col rounded-xl border px-3 py-1.5 text-xs',
        isError
          ? 'border-red-900/60 bg-red-950/30 text-red-200'
          : complete
            ? 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
            : 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--text-secondary)]',
        className,
      )}
      {...props}
    />
  );
}

type ToolHeaderProps = HTMLAttributes<HTMLDivElement> & {
  name: string;
  icon?: ReactNode;
  state?: string;
  isError?: boolean;
};

export function ToolHeader({ name, icon, state, isError = false, className, ...props }: ToolHeaderProps) {
  const status = isError
    ? 'failed'
    : state?.startsWith('output')
      ? 'returned a result'
      : 'running';

  return (
    <div className={cn('flex items-center gap-2', className)} {...props}>
      {icon ?? (name === 'web_search' ? <Search className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />)}
      <span className="font-medium text-[var(--text-primary)]">{name}</span>
      <span className="opacity-70">{status}</span>
    </div>
  );
}

export function ToolContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-2 max-w-xl rounded-lg bg-black/25 p-2 text-[11px] leading-relaxed text-[var(--text-secondary)]', className)}
      {...props}
    />
  );
}

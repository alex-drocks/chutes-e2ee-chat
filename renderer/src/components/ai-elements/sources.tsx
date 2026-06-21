'use client';

import { ChevronDown, Link } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

export type SourceItem = {
  title: string;
  url: string;
};

type SourcesProps = HTMLAttributes<HTMLDivElement> & {
  defaultOpen?: boolean;
  sources: SourceItem[];
};

export function Sources({ sources, defaultOpen = false, className, ...props }: SourcesProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (sources.length === 0) return null;

  return (
    <div className={cn('mb-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]/70', className)} {...props}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
      >
        <span className="flex items-center gap-1.5">
          <Link className="h-3 w-3" />
          Sources
          <span className="opacity-50">{sources.length}</span>
        </span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="flex flex-col gap-1 border-t border-[var(--border)] p-2">
          {sources.map((source) => (
            <a
              key={source.url}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg px-2 py-1.5 text-xs text-[var(--accent)] hover:bg-white/5 hover:underline"
            >
              {source.title || source.url}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

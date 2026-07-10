'use client';

import { ChevronDown, Link } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

export type SourceItem = {
  id?: string;
  title: string;
  url: string;
  sourceType?: string;
  extractionStatus?: 'full_page' | 'snippet_only' | 'unavailable';
  publishedAt?: string;
};

type SourcesProps = HTMLAttributes<HTMLDivElement> & {
  defaultOpen?: boolean;
  label?: string;
  sources: SourceItem[];
};

export function Sources({ sources, defaultOpen = false, label = 'Sources', className, ...props }: SourcesProps) {
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
          {label}
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
              <span className={'flex items-start gap-1.5'}>
                {source.id && <span className={'shrink-0 font-mono text-[10px] text-emerald-300'}>[{source.id}]</span>}
                <span className={'min-w-0 truncate'}>{source.title || source.url}</span>
              </span>
              {(source.sourceType || source.extractionStatus || source.publishedAt) && (
                <span className={'mt-0.5 flex flex-wrap gap-1 pl-7 text-[9px] uppercase tracking-wide text-[var(--text-secondary)]'}>
                  {source.sourceType && <span>{source.sourceType}</span>}
                  {source.extractionStatus && (
                    <span>{source.extractionStatus === 'full_page' ? 'page read' : source.extractionStatus === 'unavailable' ? 'page unavailable' : 'snippet only'}</span>
                  )}
                  {source.publishedAt && <span>{new Date(source.publishedAt).toLocaleDateString()}</span>}
                </span>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

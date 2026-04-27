'use client';

import { Streamdown } from 'streamdown';

import { cn } from '@/lib/utils';

type ResponseProps = {
  children: string;
  className?: string;
  isStreaming?: boolean;
};

export function Response({ children, className, isStreaming = false }: ResponseProps) {
  return (
    <Streamdown
      isAnimating={isStreaming}
      controls={{ code: false, table: true, mermaid: false }}
      shikiTheme={['github-light', 'github-dark-default']}
      className={cn(
        'max-w-none text-[15px] leading-7 text-[var(--text-primary)]',
        '[&_a]:text-[var(--accent)] [&_a]:underline [&_a]:underline-offset-2',
        '[&_p]:my-2 first:[&_p]:mt-0 last:[&_p]:mb-0',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-[var(--accent)]/45 [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)]',
        '[&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.92em]',
        '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-[var(--border)] [&_pre]:bg-black/35 [&_pre]:p-3',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_li]:my-1',
        '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
        '[&_td]:border [&_td]:border-[var(--border)] [&_td]:px-2 [&_td]:py-1',
        '[&_th]:border [&_th]:border-[var(--border)] [&_th]:bg-white/5 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left',
        className,
      )}
    >
      {children}
    </Streamdown>
  );
}

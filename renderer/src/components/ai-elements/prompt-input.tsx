'use client';

import type { ButtonHTMLAttributes, FormHTMLAttributes, HTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';

import { cn } from '@/lib/utils';

export const PromptInput = forwardRef<HTMLFormElement, FormHTMLAttributes<HTMLFormElement>>(
  ({ className, ...props }, ref) => (
    <form
      ref={ref}
      className={cn(
        'rounded-2xl border border-[var(--border)] bg-[var(--bg-tertiary)]/80 p-2 shadow-2xl shadow-black/20 focus-within:border-[var(--accent)]/70',
        className,
      )}
      {...props}
    />
  ),
);
PromptInput.displayName = 'PromptInput';

export const PromptInputTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={1}
      className={cn(
        'max-h-32 min-h-11 flex-1 resize-none bg-transparent px-3 py-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none disabled:opacity-60',
        className,
      )}
      {...props}
    />
  ),
);
PromptInputTextarea.displayName = 'PromptInputTextarea';

export function PromptInputBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-end gap-1', className)} {...props} />;
}

export function PromptInputFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-2 flex items-center justify-between gap-2', className)} {...props} />;
}

export function PromptInputTools({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap items-center gap-1.5', className)} {...props} />;
}

type PromptInputButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
};

export const PromptInputButton = forwardRef<HTMLButtonElement, PromptInputButtonProps>(
  ({ active = false, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        'shrink-0 rounded-xl p-3 text-[var(--text-secondary)] transition-colors hover:bg-white/5 hover:text-[var(--text-primary)] disabled:opacity-40',
        active && 'bg-[var(--accent)] text-black hover:bg-[var(--accent-hover)] hover:text-black',
        className,
      )}
      {...props}
    />
  ),
);
PromptInputButton.displayName = 'PromptInputButton';

type PromptInputSubmitProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  status: 'ready' | 'streaming' | 'submitted';
};

export const PromptInputSubmit = forwardRef<HTMLButtonElement, PromptInputSubmitProps>(
  ({ status, className, ...props }, ref) => (
    <button
      ref={ref}
      type="submit"
      className={cn(
        'shrink-0 rounded-xl bg-[var(--accent)] p-3 text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40',
        status !== 'ready' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
      {...props}
    />
  ),
);
PromptInputSubmit.displayName = 'PromptInputSubmit';

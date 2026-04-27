'use client';

import type { ButtonHTMLAttributes, FormHTMLAttributes, HTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';

import { cn } from '@/lib/utils';

export const PromptInput = forwardRef<HTMLFormElement, FormHTMLAttributes<HTMLFormElement>>(
  ({ className, ...props }, ref) => (
    <form
      ref={ref}
      className={cn(
        'rounded-2xl border border-[var(--border)] bg-[var(--bg-tertiary)]/95 p-2 shadow-2xl shadow-black/25 focus-within:border-[var(--accent)]/70',
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
        'max-h-32 min-h-10 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-5 text-[var(--text-primary)] placeholder-[var(--text-secondary)] outline-none disabled:opacity-60',
        className,
      )}
      {...props}
    />
  ),
);
PromptInputTextarea.displayName = 'PromptInputTextarea';

export function PromptInputBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2', className)} {...props} />;
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
      data-prompt-input-button="true"
      data-active={active ? 'true' : 'false'}
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-transparent p-0 text-[var(--text-secondary)] transition-colors hover:bg-white/5 hover:text-[var(--text-primary)] disabled:opacity-40',
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
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] p-0 text-black transition-colors hover:bg-[var(--accent-hover)] disabled:opacity-40',
        status !== 'ready' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
      {...props}
    />
  ),
);
PromptInputSubmit.displayName = 'PromptInputSubmit';

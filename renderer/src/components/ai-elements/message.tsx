'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import type { UIMessage } from 'ai';

import { cn } from '@/lib/utils';
import { Response } from './response';

type MessageRole = UIMessage['role'];

type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export function Message({ from, className, ...props }: MessageProps) {
  return (
    <div
      data-role={from}
      className={cn(
        'group flex w-full gap-3 py-3',
        from === 'user' ? 'justify-end' : 'justify-start',
        className,
      )}
      {...props}
    />
  );
}

type MessageContentProps = HTMLAttributes<HTMLDivElement> & {
  from?: MessageRole;
  variant?: 'contained' | 'flat';
};

export function MessageContent({
  from = 'assistant',
  variant = 'contained',
  className,
  ...props
}: MessageContentProps) {
  return (
    <div
      className={cn(
        'min-w-0 text-sm leading-relaxed',
        from === 'user'
          ? 'max-w-[min(76%,44rem)] rounded-2xl rounded-br-md bg-[var(--user-bubble)] px-4 py-2.5 text-white shadow-lg shadow-black/10'
          : variant === 'flat'
            ? 'w-full max-w-[min(82%,52rem)] px-1 py-1 text-[var(--text-primary)]'
            : 'w-full max-w-[min(82%,52rem)] rounded-2xl rounded-bl-md bg-[var(--assistant-bubble)] px-4 py-2.5 text-[var(--text-primary)] shadow-lg shadow-black/10',
        className,
      )}
      {...props}
    />
  );
}

type MessageAvatarProps = HTMLAttributes<HTMLDivElement> & {
  icon: ReactNode;
  from: MessageRole;
};

export function MessageAvatar({ icon, from, className, ...props }: MessageAvatarProps) {
  return (
    <div
      aria-hidden
      className={cn(
        'mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
        from === 'assistant'
          ? 'bg-[var(--accent)] text-black shadow-[0_0_28px_rgba(34,197,94,0.16)]'
          : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
        className,
      )}
      {...props}
    >
      {icon}
    </div>
  );
}

type MessageResponseProps = {
  children: string;
  isStreaming?: boolean;
  className?: string;
};

export function MessageResponse({ children, isStreaming, className }: MessageResponseProps) {
  return <Response isStreaming={isStreaming} className={className}>{children}</Response>;
}

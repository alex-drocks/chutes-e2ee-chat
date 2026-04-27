'use client';

import { ArrowDown } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { forwardRef, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

export const Conversation = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('relative flex min-h-0 flex-1 flex-col', className)}
      {...props}
    />
  ),
);
Conversation.displayName = 'Conversation';

type ConversationContentProps = HTMLAttributes<HTMLDivElement> & {
  autoScroll?: boolean;
};

export const ConversationContent = forwardRef<HTMLDivElement, ConversationContentProps>(
  ({ autoScroll = true, className, children, ...props }, forwardedRef) => {
    const localRef = useRef<HTMLDivElement | null>(null);
    const [isAtBottom, setIsAtBottom] = useState(true);

    useEffect(() => {
      if (!autoScroll || !isAtBottom) return;
      localRef.current?.scrollTo({ top: localRef.current.scrollHeight, behavior: 'smooth' });
    }, [autoScroll, children, isAtBottom]);

    return (
      <div
        ref={(node) => {
          localRef.current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        data-conversation-content
        onScroll={(event) => {
          const el = event.currentTarget;
          setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-8', className)}
        {...props}
      >
        {children}
      </div>
    );
  },
);
ConversationContent.displayName = 'ConversationContent';

type ConversationScrollButtonProps = HTMLAttributes<HTMLButtonElement>;

export function ConversationScrollButton({ className, ...props }: ConversationScrollButtonProps) {
  return (
    <button
      type="button"
      onClick={() => {
        document
          .querySelector<HTMLElement>('[data-conversation-content]')
          ?.scrollTo({ top: Number.MAX_SAFE_INTEGER, behavior: 'smooth' });
      }}
      className={cn(
        'absolute bottom-4 left-1/2 hidden -translate-x-1/2 rounded-full border border-[var(--border)] bg-[var(--bg-secondary)] p-2 text-[var(--text-secondary)] shadow-lg hover:text-[var(--text-primary)]',
        className,
      )}
      {...props}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}

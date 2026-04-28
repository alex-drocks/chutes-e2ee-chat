'use client';

import { memo, useState } from 'react';
import { Brain, X } from 'lucide-react';

export const MemoryRecallFencing = memo(function MemoryRecallFencing({
  memories,
  onClose,
}: {
  memories: { label: string; content: string }[];
  onClose?: (id: string) => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  if (!memories || memories.length === 0) return null;

  const visibleMemories = memories
    .map((memory, index) => ({
      ...memory,
      id: `${index}:${memory.label}:${memory.content}`,
    }))
    .filter((memory) => !hidden.has(memory.id));

  if (visibleMemories.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-violet-900/30 bg-violet-950/20 px-4 py-3 animate-in fade-in">
      <div className="flex items-center gap-1.5 mb-2 text-[10px] text-violet-400/80 uppercase tracking-wider font-medium">
        <Brain className="w-3 h-3" />
        Recalled context
      </div>
      <div className="flex flex-col gap-2">
        {visibleMemories.map((mem) => (
          <div key={mem.id} className="flex items-start gap-2">
            <div className="flex-1 text-xs text-[var(--text-secondary)] leading-relaxed border-l-2 border-violet-900/40 pl-2.5">
              <span className="text-violet-400/70 font-medium">{mem.label}: </span>
              {mem.content}
            </div>
            <button
              onClick={() => {
                setHidden((current) => new Set(current).add(mem.id));
                onClose?.(mem.id);
              }}
              className="shrink-0 p-0.5 rounded hover:bg-white/5 text-[var(--text-secondary)] transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
});

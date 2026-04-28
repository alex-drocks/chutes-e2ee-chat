'use client';

import { memo } from 'react';
import { Brain, X } from 'lucide-react';

export const MemoryRecallFencing = memo(function MemoryRecallFencing({
  memories,
  onClose,
}: {
  memories: { label: string; content: string }[];
  onClose: (id: string) => void;
}) {
  if (!memories || memories.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-violet-900/30 bg-violet-950/20 px-4 py-3 animate-in fade-in">
      <div className="flex items-center gap-1.5 mb-2 text-[10px] text-violet-400/80 uppercase tracking-wider font-medium">
        <Brain className="w-3 h-3" />
        Recalled context
      </div>
      <div className="flex flex-col gap-2">
        {memories.map((mem, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1 text-xs text-[var(--text-secondary)] leading-relaxed border-l-2 border-violet-900/40 pl-2.5">
              <span className="text-violet-400/70 font-medium">{mem.label}: </span>
              {mem.content}
            </div>
            <button
              onClick={() => onClose(`recall-${i}`)}
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

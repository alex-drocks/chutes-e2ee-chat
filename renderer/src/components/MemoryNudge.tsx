'use client';

import { useState, memo } from 'react';
import { Sparkles, Brain, X, Check, Plus, Wrench } from 'lucide-react';
import type { Memory, Skill } from '@/lib/memoryStore';

export interface NudgeAction {
  id: string;
  type: 'save_memory' | 'create_skill' | 'update_profile';
  label: string;
  description: string;
  suggestions?: string[];
}

function NudgeCard({
  nudge,
  onAction,
  onDismiss,
}: {
  nudge: NudgeAction;
  onAction: (nudge: NudgeAction, choice: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const icon =
    nudge.type === 'save_memory' ? (
      <Brain className="w-4 h-4 text-violet-400" />
    ) : nudge.type === 'create_skill' ? (
      <Wrench className="w-4 h-4 text-amber-400" />
    ) : (
      <Sparkles className="w-4 h-4 text-emerald-400" />
    );

  return (
    <div
      className={`relative flex flex-col gap-2 rounded-xl border px-4 py-3 bg-gradient-to-r ${
        nudge.type === 'save_memory'
          ? 'from-violet-950/40 to-transparent border-violet-900/40'
          : nudge.type === 'create_skill'
          ? 'from-amber-950/40 to-transparent border-amber-900/40'
          : 'from-emerald-950/40 to-transparent border-emerald-900/40'
      } text-xs animate-in slide-up`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium text-[var(--text-primary)]">{nudge.label}</span>
        </div>
        <button
          onClick={() => {
            setDismissing(true);
            setTimeout(() => onDismiss(nudge.id), 200);
          }}
          className="p-0.5 rounded hover:bg-white/5 text-[var(--text-secondary)] transition-colors shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      <p className="text-[var(--text-secondary)] leading-relaxed">{nudge.description}</p>

      {nudge.suggestions && nudge.suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {nudge.suggestions.map((s) => (
            <button
              key={s}
              onClick={() => {
                setSelected(s);
                onAction(nudge, s);
              }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] transition-all ${
                selected === s
                  ? 'bg-[var(--accent)] text-black'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/80'
              }`}
            >
              {selected === s ? (
                <Check className="w-3 h-3" />
              ) : (
                <Plus className="w-3 h-3" />
              )}
              {s}
            </button>
          ))}
        </div>
      )}

      {dismissing && <div className="absolute inset-0 bg-black/10 rounded-xl" />}
    </div>
  );
}

export const MemoryNudge = memo(function MemoryNudge({
  nudges,
  onAction,
  onDismiss,
}: {
  nudges: NudgeAction[];
  onAction: (nudge: NudgeAction, choice: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (nudges.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 my-2">
      {nudges.map((n) => (
        <NudgeCard key={n.id} nudge={n} onAction={onAction} onDismiss={onDismiss} />
      ))}
    </div>
  );
});

export function MemoryRecallFencing({
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
}

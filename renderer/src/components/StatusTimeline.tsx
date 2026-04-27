'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Brain,
  Globe,
  CheckCircle2,
  Loader2,
  WifiOff,
  Shield,
  Zap,
  Lock,
  Fingerprint,
  Search,
  Wrench,
} from 'lucide-react';
import type { MessageStatus } from '@/lib/types';

const STATUS_ICONS: Record<string, React.ElementType> = {
  thinking: Brain,
  encrypting: Lock,
  connecting: Fingerprint,
  streaming: Zap,
  web_search: Globe,
  tool_call: Wrench,
  tool_result: CheckCircle2,
  search: Search,
  retry: Loader2,
  fallback: Shield,
  error: AlertCircle,
  network: WifiOff,
};

function getIconForAction(action: string): React.ElementType {
  for (const key of Object.keys(STATUS_ICONS)) {
    if (action.toLowerCase().includes(key)) return STATUS_ICONS[key];
  }
  return Zap;
}

function StatusBadge({ status }: { status: MessageStatus }) {
  const Icon = getIconForAction(status.action);
  const isDone = status.done;
  const isError = status.level === 'error';
  const isWarning = status.level === 'warning';

  return (
    <div className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs border transition-all ${
      isError
        ? 'bg-red-950/40 border-red-900/50 text-red-300'
        : isWarning
        ? 'bg-yellow-950/40 border-yellow-900/50 text-yellow-300'
        : isDone
        ? 'bg-emerald-950/30 border-emerald-900/40 text-emerald-300'
        : 'bg-[var(--bg-tertiary)]/60 border-[var(--border)]/60 text-[var(--text-secondary)]'
    }`}>
      {isDone && !isError ? (
        <CheckCircle2 className="w-3 h-3 shrink-0" />
      ) : (
        <Icon className={`w-3 h-3 shrink-0 ${!isDone && !isError ? 'animate-pulse' : ''}`} />
      )}
      <span className="truncate max-w-[200px]">{status.description}</span>
    </div>
  );
}

export function StatusTimeline({
  history,
  compact = false,
}: {
  history: MessageStatus[];
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!history || history.length === 0) return null;

  const visible = expanded ? history : history.slice(-2);
  const hasMore = history.length > 2;

  if (compact) {
    const last = history[history.length - 1];
    return <StatusBadge status={last} />;
  }

  return (
    <div className="flex flex-col gap-1.5 my-2 animate-in fade-in">
      <div className="flex flex-wrap gap-1.5">
        {visible.map((s, i) => (
          <StatusBadge key={i} status={s} />
        ))}
      </div>
      {hasMore && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors self-start"
        >
          {expanded ? (
            <>
              <ChevronUp className="w-3 h-3" /> Collapse
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3" /> Show {history.length - 2} more
            </>
          )}
        </button>
      )}
    </div>
  );
}

export function LiveStatusCard({ status }: { status?: MessageStatus }) {
  if (!status) return null;
  const Icon = getIconForAction(status.action);

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)]/50 border border-[var(--border)]/50 text-xs text-[var(--text-secondary)] animate-in fade-in">
      <Icon className="w-3.5 h-3.5 text-[var(--accent)] animate-pulse shrink-0" />
      <span>{status.description}</span>
    </div>
  );
}

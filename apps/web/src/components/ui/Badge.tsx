import type { ReactNode } from 'react';
import { cn } from '../../lib/format.js';

type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-ink-2 border-line',
  primary: 'bg-primary-soft text-primary-strong border-transparent',
  success: 'bg-success-soft text-success border-transparent',
  warning: 'bg-warning-soft text-warning border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent',
  info: 'bg-info-soft text-info border-transparent',
};

export function Badge({
  children,
  tone = 'neutral',
  dot,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        TONE[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** 状态 → 徽标色调映射（复用各状态枚举） */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'active':
    case 'success':
    case 'published':
      return 'success';
    case 'disabled':
    case 'draft':
    case 'pending':
    case 'archived':
      return 'neutral';
    case 'failed':
      return 'danger';
    case 'parsing':
    case 'splitting':
    case 'indexing':
      return 'warning';
    case 'processing':
      return 'info';
    default:
      return 'neutral';
  }
}

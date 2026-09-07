import type { ReactNode } from 'react';

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-spin ${className ?? ''}`}
      aria-label="加载中"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function LoadingBlock({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-ink-3">
      <Spinner size={18} />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function FullPageLoader({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[40vh] items-center justify-center gap-3 text-ink-3">
      <Spinner size={22} />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function InlineStatus({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {busy && <Spinner size={12} />}
      {children}
    </span>
  );
}

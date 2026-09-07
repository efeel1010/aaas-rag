import { useState } from 'react';
import { cn } from '../../lib/format.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 只读 JSON 展示（可展开/折叠） */
export function JsonView({
  value,
  label,
  defaultCollapsed = false,
  className,
  maxHeight,
}: {
  value: unknown;
  label?: string;
  defaultCollapsed?: boolean;
  className?: string;
  maxHeight?: number;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const text = stringify(value);

  return (
    <div className={cn('overflow-hidden rounded-lg border border-line-soft bg-canvas/60', className)}>
      <div className="flex items-center justify-between border-b border-line-soft px-3 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-2 hover:text-ink"
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
          {label ?? 'JSON'}
        </button>
        <button
          type="button"
          onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}
          className="rounded p-1 text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
          aria-label="复制 JSON"
        >
          <Icon name="copy" size={13} />
        </button>
      </div>
      {!collapsed && (
        <pre
          className="overflow-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-2"
          style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}
        >
          {text}
        </pre>
      )}
    </div>
  );
}

/** 复制文本小按钮 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn('px-1.5', className)}
      icon={<Icon name={copied ? 'check' : 'copy'} size={13} />}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    />
  );
}

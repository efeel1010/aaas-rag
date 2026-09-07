import type { ReactNode } from 'react';
import { cn } from '../../lib/format.js';

export interface TabItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  count?: number;
}

export function Tabs({
  items,
  active,
  onChange,
  className,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 border-b border-line-soft overflow-x-auto',
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={cn(
              'relative flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 text-sm transition-colors',
              isActive ? 'text-ink font-medium' : 'text-ink-3 hover:text-ink-2',
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn(
                  'ml-0.5 rounded-full px-1.5 py-px text-[11px]',
                  isActive ? 'bg-primary-soft text-primary-strong' : 'bg-surface-3 text-ink-3',
                )}
              >
                {item.count}
              </span>
            )}
            {isActive && (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}

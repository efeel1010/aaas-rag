import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';

export function EmptyState({
  icon = 'box',
  title,
  description,
  action,
  className,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 py-14 text-center ${className ?? ''}`}>
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-3">
        <Icon name={icon} size={22} />
      </div>
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {description && <p className="mt-1 max-w-sm text-[13px] text-ink-3">{description}</p>}
      </div>
      {action}
    </div>
  );
}

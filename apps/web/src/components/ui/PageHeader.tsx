import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/format.js';
import { Icon } from './Icon.js';

/** 页面标题区：标题（Georgia）+ 描述 + 右侧操作 */
export function PageHeader({
  title,
  description,
  actions,
  backTo,
  backLabel = '返回',
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {backTo && (
          <Link
            to={backTo}
            className="mb-2 inline-flex items-center gap-1 text-[13px] text-ink-3 transition-colors hover:text-ink"
          >
            <Icon name="chevron-left" size={14} />
            {backLabel}
          </Link>
        )}
        <h1 className={cn('font-display text-2xl font-semibold leading-tight text-ink')}>{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

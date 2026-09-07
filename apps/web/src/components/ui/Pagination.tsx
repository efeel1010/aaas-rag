import { cn } from '../../lib/format.js';
import { Icon } from './Icon.js';

export function Pagination({
  page,
  perPage,
  total,
  onChange,
}: {
  page: number;
  perPage: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-4 py-3 text-[13px] text-ink-3">
      <span>
        共 {total} 条 · 第 {page}/{pages} 页
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-2',
            'hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed',
          )}
          aria-label="上一页"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <button
          type="button"
          disabled={page >= pages}
          onClick={() => onChange(page + 1)}
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md border border-line text-ink-2',
            'hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed',
          )}
          aria-label="下一页"
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>
    </div>
  );
}

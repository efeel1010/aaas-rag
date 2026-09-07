import type { ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/format.js';

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface', padded && 'p-5', className)}>
      {children}
    </div>
  );
}

export function TableShell({
  children,
  className,
  ...rest
}: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className={cn('overflow-x-auto rounded-xl border border-line bg-surface', className)}>
      <table className="w-full min-w-full border-collapse text-sm" {...rest}>
        {children}
      </table>
    </div>
  );
}

export function THead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead className={cn('border-b border-line-soft bg-surface-2', className)}>
      {children}
    </thead>
  );
}

export function Th({ children, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-ink-3 whitespace-nowrap',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export function Tr({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'border-b border-line-soft last:border-b-0 transition-colors',
        onClick && 'cursor-pointer hover:bg-surface-2',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function Td({ children, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-4 py-3 align-middle text-ink-2', className)} {...rest}>
      {children}
    </td>
  );
}

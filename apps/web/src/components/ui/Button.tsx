import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/format.js';
import { Spinner } from './Spinner.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
}

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-primary text-white hover:bg-primary-strong active:bg-primary border border-transparent shadow-[0_1px_2px_rgba(0,0,0,0.3)]',
  secondary:
    'bg-surface-3 text-ink hover:bg-surface-4 active:bg-surface-3 border border-line text-ink',
  ghost: 'bg-transparent text-ink-2 hover:text-ink hover:bg-surface-2 border border-transparent',
  danger: 'bg-danger text-white hover:brightness-110 active:brightness-95 border border-transparent',
  'danger-ghost': 'bg-transparent text-danger hover:bg-danger-soft border border-transparent',
};

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  block,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center font-medium transition-all duration-150 select-none',
        'whitespace-nowrap shrink-0',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
        'active:scale-[0.98]',
        VARIANT[variant],
        SIZE[size],
        block && 'w-full',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={14} className="text-current" /> : icon}
      {children}
    </button>
  );
}

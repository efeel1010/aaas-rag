import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/format.js';
import { Icon } from './Icon.js';

const CONTROL_BASE =
  'w-full bg-surface-2 text-ink placeholder:text-ink-3 border border-line rounded-lg px-3 text-sm ' +
  'transition-colors duration-150 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  prefixIcon?: ReactNode;
  /** 尺寸：md（默认 h-9）/ sm（h-8 更紧凑） */
  size?: 'sm' | 'md';
}

export function Input({ className, prefixIcon, size = 'md', ...rest }: InputProps) {
  const height = size === 'sm' ? 'h-8 text-[13px]' : 'h-9';
  if (prefixIcon) {
    return (
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
          {prefixIcon}
        </span>
        <input className={cn(CONTROL_BASE, height, 'pl-9', className)} {...rest} />
      </div>
    );
  }
  return <input className={cn(CONTROL_BASE, height, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL_BASE, 'py-2 leading-relaxed', className)} {...rest} />;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: Array<{ value: string; label: string; disabled?: boolean }>;
  /** 使用 children 时忽略 options */
  children?: ReactNode;
}

export function Select({ className, options, children, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select
        className={cn(CONTROL_BASE, 'h-9 appearance-none pr-8 cursor-pointer', className)}
        {...rest}
      >
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled} className="bg-surface-2 text-ink">
                {o.label}
              </option>
            ))
          : children}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3">
        <Icon name="chevron-down" size={14} />
      </span>
    </div>
  );
}

/** 表单字段包装：label + 必填标记 + 帮助文案 + 错误提示 */
export function Field({
  label,
  required,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="flex items-center gap-1 text-[13px] font-medium text-ink-2"
        >
          {label}
          {required && <span className="text-danger">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-xs text-ink-3">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

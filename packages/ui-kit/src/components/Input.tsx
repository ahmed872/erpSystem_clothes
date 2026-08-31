import { InputHTMLAttributes, forwardRef, ReactNode } from 'react';
import clsx from 'clsx';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  startAdornment?: ReactNode;
  endAdornment?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, startAdornment, endAdornment, className, id, ...rest },
  ref,
) {
  const inputId = id ?? rest.name;
  return (
    <label className="flex flex-col gap-1.5 text-start" htmlFor={inputId}>
      {label && <span className="text-sm font-medium text-neutral-700">{label}</span>}
      <span
        className={clsx(
          'flex items-center gap-2 rounded-lg border bg-white px-3 h-10 transition-colors',
          error ? 'border-danger-400 focus-within:border-danger-500' : 'border-neutral-300 focus-within:border-brand-500',
        )}
      >
        {startAdornment}
        <input
          ref={ref}
          id={inputId}
          className={clsx('w-full border-0 bg-transparent p-0 text-sm text-neutral-900 outline-none placeholder:text-neutral-400', className)}
          {...rest}
        />
        {endAdornment}
      </span>
      {error ? (
        <span className="text-xs text-danger-600">{error}</span>
      ) : hint ? (
        <span className="text-xs text-neutral-500">{hint}</span>
      ) : null}
    </label>
  );
});
